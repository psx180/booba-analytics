import type { PrismaClient } from '../../../../generated/prisma/client';
import type { Position } from '../aggregations/base';
import type { EquitySourceProvider, EquityPoint, DailyReturn } from './types';

// Snapshot-based equity provider with Time-Weighted Return for daily returns.
//
// Source of truth is the EquitySnapshot table (Pacifica /portfolio history).
// Cash flows from BalanceEvent (deposit/withdrawal) are folded into the peak-
// equity calculation so deposits don't manufacture a fake recovery and
// withdrawals don't look like a drawdown. When no snapshots exist (new wallet,
// API hiccup) we fall back to position-based reconstruction with deposit-sum
// or a hard-coded $10k as the starting capital floor.

export class SnapshotTwrProvider implements EquitySourceProvider {
  name = 'snapshot-twr';

  constructor(private db: PrismaClient) {}

  async getStartingCapital(walletAddress: string): Promise<number> {
    const earliest = await this.db.equitySnapshot.findFirst({
      where: { walletAddress },
      orderBy: { timestamp: 'asc' },
    });
    if (earliest && earliest.accountEquity > 0) return earliest.accountEquity;

    // Fallback: sum deposits from the balance event log.
    const deposits = await this.db.balanceEvent.findMany({
      where: { walletAddress, eventType: { in: ['deposit', 'DEPOSIT'] } },
    });
    const sum = deposits.reduce((s, d) => s + d.amount, 0);
    if (sum > 0) return sum;

    return 10000;
  }

  async getEquityCurve(walletAddress: string, positions: Position[]): Promise<EquityPoint[]> {
    const snapshots = await this.db.equitySnapshot.findMany({
      where: { walletAddress },
      orderBy: { timestamp: 'asc' },
    });

    const cashFlowEvents = await this.db.balanceEvent.findMany({
      where: {
        walletAddress,
        eventType: { in: ['deposit', 'withdrawal', 'DEPOSIT', 'WITHDRAWAL'] },
      },
      orderBy: { timestamp: 'asc' },
    });

    const closedPositions = positions
      .filter((p) => p.status === 'closed' && p.aggregatePnl != null && p.lastExitTime != null)
      .sort((a, b) => a.lastExitTime!.getTime() - b.lastExitTime!.getTime());

    if (snapshots.length === 0) {
      return this.fallbackFromPositions(walletAddress, closedPositions);
    }

    let peakEquity = 0;
    let cfIndex = 0;
    let posIndex = 0;
    let cumulativePnl = 0;
    const series: EquityPoint[] = [];

    for (const snap of snapshots) {
      const equity = snap.accountEquity;

      // Fold any cash flows that occurred up through this snapshot into the
      // peak-equity baseline. Deposits push the peak up by the deposit amount
      // (so a deposit-driven equity bump doesn't look like a recovery to HWM);
      // withdrawals pull the peak down but never below the current equity
      // (otherwise withdrawing would manufacture a fresh drawdown floor).
      while (cfIndex < cashFlowEvents.length && cashFlowEvents[cfIndex].timestamp <= snap.timestamp) {
        const cf = cashFlowEvents[cfIndex];
        const isDeposit = cf.eventType.toLowerCase().includes('deposit');
        const isWithdrawal = cf.eventType.toLowerCase().includes('withdraw');
        if (isDeposit) {
          peakEquity += Math.abs(cf.amount);
        } else if (isWithdrawal) {
          peakEquity = Math.max(peakEquity - Math.abs(cf.amount), equity);
        }
        cfIndex++;
      }

      while (
        posIndex < closedPositions.length &&
        closedPositions[posIndex].lastExitTime! <= snap.timestamp
      ) {
        cumulativePnl += closedPositions[posIndex].aggregatePnl ?? 0;
        posIndex++;
      }

      if (equity > peakEquity) peakEquity = equity;

      const underwaterPct = peakEquity > 0
        ? ((equity - peakEquity) / peakEquity) * 100
        : 0;

      const nearestPos = closedPositions.find(
        (p) =>
          p.firstEntryTime != null &&
          p.firstEntryTime <= snap.timestamp &&
          (!p.lastExitTime || p.lastExitTime >= snap.timestamp),
      );

      series.push({
        timestamp: snap.timestamp,
        equity,
        cumulativePnl,
        peakEquity,
        underwaterPct: Math.max(-100, Math.min(0, underwaterPct)),
        underwaterDollars: equity - peakEquity,
        regime: nearestPos?.regimeAtEntry ?? null,
      });
    }

    return series;
  }

  async getDailyReturns(walletAddress: string, positions: Position[]): Promise<DailyReturn[]> {
    const snapshots = await this.db.equitySnapshot.findMany({
      where: { walletAddress },
      orderBy: { timestamp: 'asc' },
    });

    const cashFlowEvents = await this.db.balanceEvent.findMany({
      where: {
        walletAddress,
        eventType: { in: ['deposit', 'withdrawal', 'DEPOSIT', 'WITHDRAWAL'] },
      },
      orderBy: { timestamp: 'asc' },
    });

    if (snapshots.length === 0) {
      return this.fallbackDailyReturns(walletAddress, positions);
    }

    // First and last snapshot equity per UTC date.
    const dailySnaps = new Map<string, { first: number; last: number }>();
    for (const snap of snapshots) {
      const dateStr = snap.timestamp.toISOString().split('T')[0];
      const equity = snap.accountEquity;
      const existing = dailySnaps.get(dateStr);
      if (!existing) {
        dailySnaps.set(dateStr, { first: equity, last: equity });
      } else {
        existing.last = equity;
      }
    }

    const dailyCashFlows = new Map<string, number>();
    for (const cf of cashFlowEvents) {
      const dateStr = cf.timestamp.toISOString().split('T')[0];
      const isDeposit = cf.eventType.toLowerCase().includes('deposit');
      const signedAmount = isDeposit ? Math.abs(cf.amount) : -Math.abs(cf.amount);
      dailyCashFlows.set(dateStr, (dailyCashFlows.get(dateStr) ?? 0) + signedAmount);
    }

    const dailyTradeCount = new Map<string, number>();
    for (const pos of positions) {
      if (pos.status !== 'closed' || !pos.lastExitTime) continue;
      const dateStr = pos.lastExitTime.toISOString().split('T')[0];
      dailyTradeCount.set(dateStr, (dailyTradeCount.get(dateStr) ?? 0) + 1);
    }

    const dates = [...dailySnaps.keys()].sort();
    const returns: DailyReturn[] = [];
    let prevEndEquity: number | null = null;

    for (const date of dates) {
      const { first, last } = dailySnaps.get(date)!;
      const cashFlows = dailyCashFlows.get(date) ?? 0;
      const tradeCount = dailyTradeCount.get(date) ?? 0;

      const equityAtStart = prevEndEquity ?? first;
      const equityAtEnd = last;

      let returnPct: number;
      if (Math.abs(cashFlows) < 0.01) {
        returnPct = equityAtStart > 0
          ? ((equityAtEnd - equityAtStart) / equityAtStart) * 100
          : 0;
      } else {
        // TWR with cash flow assumed at start-of-day. Conservative because it
        // attributes the day's gains/losses to the post-injection capital
        // base rather than the pre-injection one.
        const adjustedStart = equityAtStart + cashFlows;
        returnPct = adjustedStart > 0
          ? ((equityAtEnd - adjustedStart) / adjustedStart) * 100
          : 0;
      }

      const pnl = equityAtEnd - equityAtStart - cashFlows;

      returns.push({
        date,
        pnl,
        returnPct,
        equityAtStart,
        equityAtEnd,
        cashFlows,
        tradeCount,
      });

      prevEndEquity = equityAtEnd;
    }

    return returns;
  }

  private async fallbackFromPositions(
    walletAddress: string,
    positions: Position[],
  ): Promise<EquityPoint[]> {
    const startingCapital = await this.getStartingCapital(walletAddress);
    let cumPnl = 0;
    let peak = startingCapital;
    const series: EquityPoint[] = [];

    for (const pos of positions) {
      cumPnl += pos.aggregatePnl ?? 0;
      const eq = startingCapital + cumPnl;
      if (eq > peak) peak = eq;
      const uwPct = peak > 0 ? ((eq - peak) / peak) * 100 : 0;

      series.push({
        timestamp: pos.lastExitTime!,
        equity: eq,
        cumulativePnl: cumPnl,
        peakEquity: peak,
        underwaterPct: Math.max(-100, Math.min(0, uwPct)),
        underwaterDollars: eq - peak,
        regime: pos.regimeAtEntry ?? null,
      });
    }

    return series;
  }

  private async fallbackDailyReturns(
    walletAddress: string,
    positions: Position[],
  ): Promise<DailyReturn[]> {
    const startingCapital = await this.getStartingCapital(walletAddress);
    const closed = positions.filter(
      (p) => p.status === 'closed' && p.aggregatePnl != null && p.lastExitTime != null,
    );

    const byDate = new Map<string, Position[]>();
    for (const pos of closed) {
      const dateStr = pos.lastExitTime!.toISOString().split('T')[0];
      if (!byDate.has(dateStr)) byDate.set(dateStr, []);
      byDate.get(dateStr)!.push(pos);
    }

    let cumPnl = 0;
    const returns: DailyReturn[] = [];
    for (const date of [...byDate.keys()].sort()) {
      const dayPositions = byDate.get(date)!;
      const eqStart = startingCapital + cumPnl;
      const dayPnl = dayPositions.reduce((sum, p) => sum + (p.aggregatePnl ?? 0), 0);
      cumPnl += dayPnl;

      returns.push({
        date,
        pnl: dayPnl,
        returnPct: eqStart > 0 ? (dayPnl / eqStart) * 100 : 0,
        equityAtStart: eqStart,
        equityAtEnd: startingCapital + cumPnl,
        cashFlows: 0,
        tradeCount: dayPositions.length,
      });
    }
    return returns;
  }
}
