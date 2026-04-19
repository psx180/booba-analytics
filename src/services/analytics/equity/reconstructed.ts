import type { PrismaClient } from '../../../../generated/prisma/client';
import type { Position } from '../aggregations/base';
import type { EquitySourceProvider, EquityPoint, DailyReturn } from './types';

// Pure in-database reconstruction of account equity: no Pacifica /portfolio
// snapshots involved, no assumption of a single starting capital. At any
// point in time:
//   equity(t) = Σ deposits≤t − Σ withdrawals≤t + Σ realized P&L≤t
// The BalanceEvent table supplies the deposits/withdrawals; the positions
// argument (already filtered and journal-scoped by the caller) supplies the
// realized P&L. Because we sample equity at every position close, the output
// aligns point-for-point with the P&L chart.

interface CashFlowEvent {
  timestamp: Date;
  amount: number; // positive for deposits, negative for withdrawals
}

export class ReconstructedProvider implements EquitySourceProvider {
  name = 'reconstructed';

  constructor(private db: PrismaClient) {}

  async getStartingCapital(walletAddress: string): Promise<number> {
    const firstDeposit = await this.db.balanceEvent.findFirst({
      where: {
        walletAddress,
        eventType: { in: ['deposit', 'DEPOSIT'] },
      },
      orderBy: { timestamp: 'asc' },
    });
    if (firstDeposit && firstDeposit.amount > 0) return firstDeposit.amount;
    return 10000;
  }

  async getEquityCurve(walletAddress: string, positions: Position[]): Promise<EquityPoint[]> {
    const balanceEvents = await this.db.balanceEvent.findMany({
      where: {
        walletAddress,
        eventType: {
          in: ['deposit', 'withdraw', 'withdrawal', 'DEPOSIT', 'WITHDRAW', 'WITHDRAWAL'],
        },
      },
      orderBy: { timestamp: 'asc' },
    });

    const cashFlows: CashFlowEvent[] = balanceEvents.map((e) => {
      const isDeposit = e.eventType.toLowerCase().includes('deposit');
      return {
        timestamp: e.timestamp,
        amount: isDeposit ? Math.abs(e.amount) : -Math.abs(e.amount),
      };
    });

    const closed = positions
      .filter((p) => p.status === 'closed' && p.aggregatePnl != null && p.lastExitTime != null)
      .sort((a, b) => a.lastExitTime!.getTime() - b.lastExitTime!.getTime());

    if (closed.length === 0) return [];

    // N cash flows × M positions is trivial at our scale (≈25 × ≈330). If this
    // ever matters, switch to a single forward pass with a cash-flow pointer.
    let cumulativePnl = 0;
    let peakEquity = 0;
    const series: EquityPoint[] = [];

    for (const p of closed) {
      cumulativePnl += p.aggregatePnl ?? 0;
      const closeTime = p.lastExitTime!;

      const netCashFlows = cashFlows
        .filter((cf) => cf.timestamp <= closeTime)
        .reduce((sum, cf) => sum + cf.amount, 0);

      const equity = netCashFlows + cumulativePnl;

      if (equity > peakEquity) peakEquity = equity;

      // safePeak guards the first position's underwater % — before any deposit
      // has posted, peakEquity can be 0 and the ratio blows up.
      const safePeak = Math.max(peakEquity, 1);
      const underwaterPct = ((equity - safePeak) / safePeak) * 100;
      const underwaterDollars = equity - safePeak;

      series.push({
        timestamp: closeTime,
        equity,
        cumulativePnl,
        peakEquity: safePeak,
        underwaterPct: Math.max(-100, Math.min(0, underwaterPct)),
        underwaterDollars: Math.min(0, underwaterDollars),
        regime: p.regimeAtEntry ?? null,
      });
    }

    if (series.length > 0) {
      console.log(
        `[reconstructed] First equity: ${series[0].equity.toFixed(2)} ` +
          `Last equity: ${series[series.length - 1].equity.toFixed(2)} ` +
          `(${series.length} points)`,
      );
    }

    return series;
  }

  async getDailyReturns(walletAddress: string, positions: Position[]): Promise<DailyReturn[]> {
    const balanceEvents = await this.db.balanceEvent.findMany({
      where: {
        walletAddress,
        eventType: {
          in: ['deposit', 'withdraw', 'withdrawal', 'DEPOSIT', 'WITHDRAW', 'WITHDRAWAL'],
        },
      },
      orderBy: { timestamp: 'asc' },
    });

    const cashFlows: CashFlowEvent[] = balanceEvents.map((e) => {
      const isDeposit = e.eventType.toLowerCase().includes('deposit');
      return {
        timestamp: e.timestamp,
        amount: isDeposit ? Math.abs(e.amount) : -Math.abs(e.amount),
      };
    });

    const closed = positions
      .filter((p) => p.status === 'closed' && p.aggregatePnl != null && p.lastExitTime != null)
      .sort((a, b) => a.lastExitTime!.getTime() - b.lastExitTime!.getTime());

    const byDate = new Map<string, Position[]>();
    for (const pos of closed) {
      const dateStr = pos.lastExitTime!.toISOString().split('T')[0];
      if (!byDate.has(dateStr)) byDate.set(dateStr, []);
      byDate.get(dateStr)!.push(pos);
    }

    const cashFlowsByDate = new Map<string, number>();
    for (const cf of cashFlows) {
      const dateStr = cf.timestamp.toISOString().split('T')[0];
      cashFlowsByDate.set(dateStr, (cashFlowsByDate.get(dateStr) ?? 0) + cf.amount);
    }

    let cumulativePnl = 0;
    let cumulativeCashFlows = 0;
    const returns: DailyReturn[] = [];

    for (const date of [...byDate.keys()].sort()) {
      const dayPositions = byDate.get(date)!;
      const dayCashFlows = cashFlowsByDate.get(date) ?? 0;

      const equityAtStart = cumulativeCashFlows + cumulativePnl;

      const dayPnl = dayPositions.reduce((sum, p) => sum + (p.aggregatePnl ?? 0), 0);
      cumulativePnl += dayPnl;
      cumulativeCashFlows += dayCashFlows;

      const equityAtEnd = cumulativeCashFlows + cumulativePnl;

      // TWR: isolate the day's trading return from deposit/withdrawal timing
      // by pushing the cash flow to the start of the day (conservative — it
      // attributes the day's gains to the post-injection capital base).
      const adjustedStart = equityAtStart + dayCashFlows;
      const returnPct = adjustedStart > 0 ? (dayPnl / adjustedStart) * 100 : 0;

      returns.push({
        date,
        pnl: dayPnl,
        returnPct,
        equityAtStart,
        equityAtEnd,
        cashFlows: dayCashFlows,
        tradeCount: dayPositions.length,
      });
    }

    return returns;
  }
}
