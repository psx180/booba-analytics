import type { PrismaClient } from '../../../../generated/prisma/client';
import type { Position } from '../aggregations/base';
import type { EquitySourceProvider, EquityPoint, DailyReturn } from './types';
import { PacificaClient } from '../../pacifica';

export class StartingCapitalProvider implements EquitySourceProvider {
  name = 'starting-capital';

  constructor(private db: PrismaClient) {}

  async getStartingCapital(walletAddress: string): Promise<number> {
    const journal = await this.db.journal.findFirst({ where: { walletAddress } });
    if (journal?.startingCapital != null && journal.startingCapital > 0) {
      return journal.startingCapital;
    }
    return this.computeAndStore(walletAddress);
  }

  private async computeAndStore(walletAddress: string): Promise<number> {
    let startingCapital = 10000;
    let source = 'default';

    const client = new PacificaClient({ walletAddress });

    // Attempt 1: earliest equity snapshot from Pacifica
    try {
      const snapshots = await client.account.getEquityHistory({ timeRange: 'all' });
      if (snapshots.length > 0) {
        const sorted = [...snapshots].sort((a, b) => a.timestamp - b.timestamp);
        const value = parseFloat(sorted[0].account_equity);
        if (value > 0) {
          startingCapital = value;
          source = 'portfolio_snapshot';
        }
      }
    } catch (e) {
      console.warn('[equity] Failed to fetch portfolio snapshots:', e);
    }

    // Attempt 2: sum deposits from balance history
    if (source === 'default') {
      try {
        const result = await client.account.getBalanceHistory();
        const depositSum = result.data
          .filter((entry) => entry.event_type.toLowerCase().includes('deposit'))
          .reduce((acc, entry) => acc + parseFloat(entry.amount), 0);
        if (depositSum > 0) {
          startingCapital = depositSum;
          source = 'deposit_sum';
        }
      } catch (e) {
        console.warn('[equity] Failed to fetch balance history:', e);
      }
    }

    console.log(`[equity] Starting capital for ${walletAddress}: $${startingCapital} (source: ${source})`);

    const journal = await this.db.journal.findFirst({ where: { walletAddress } });
    if (journal) {
      await this.db.journal.update({
        where: { id: journal.id },
        data: { startingCapital, startingCapitalSource: source },
      });
    }

    return startingCapital;
  }

  async getEquityCurve(walletAddress: string, positions: Position[]): Promise<EquityPoint[]> {
    const startingCapital = await this.getStartingCapital(walletAddress);

    const closed = positions
      .filter((p) => p.status === 'closed' && p.aggregatePnl != null && p.lastExitTime != null)
      .sort((a, b) => a.lastExitTime!.getTime() - b.lastExitTime!.getTime());

    let cumulativePnl = 0;
    let peakEquity = startingCapital;
    const series: EquityPoint[] = [];

    for (const p of closed) {
      cumulativePnl += p.aggregatePnl ?? 0;
      const equity = startingCapital + cumulativePnl;
      if (equity > peakEquity) peakEquity = equity;

      // peakEquity is always >= startingCapital (which is > 0), so division is always safe
      const underwaterPct = ((equity - peakEquity) / peakEquity) * 100;
      const underwaterDollars = equity - peakEquity;

      series.push({
        timestamp: p.lastExitTime!,
        equity,
        cumulativePnl,
        peakEquity,
        underwaterPct,
        underwaterDollars,
        regime: p.regimeAtEntry ?? null,
      });
    }

    return series;
  }

  async getDailyReturns(walletAddress: string, positions: Position[]): Promise<DailyReturn[]> {
    const startingCapital = await this.getStartingCapital(walletAddress);

    const closed = positions
      .filter((p) => p.status === 'closed' && p.aggregatePnl != null && p.lastExitTime != null)
      .sort((a, b) => a.lastExitTime!.getTime() - b.lastExitTime!.getTime());

    const byDate = new Map<string, Position[]>();
    for (const pos of closed) {
      const dateStr = pos.lastExitTime!.toISOString().split('T')[0];
      if (!byDate.has(dateStr)) byDate.set(dateStr, []);
      byDate.get(dateStr)!.push(pos);
    }

    let cumulativePnl = 0;
    const returns: DailyReturn[] = [];

    for (const date of [...byDate.keys()].sort()) {
      const dayPositions = byDate.get(date)!;
      const equityAtStart = startingCapital + cumulativePnl;
      const dayPnl = dayPositions.reduce((sum, p) => sum + (p.aggregatePnl ?? 0), 0);
      cumulativePnl += dayPnl;

      returns.push({
        date,
        pnl: dayPnl,
        returnPct: equityAtStart > 0 ? (dayPnl / equityAtStart) * 100 : 0,
        equityAtStart,
        equityAtEnd: startingCapital + cumulativePnl,
        cashFlows: 0,
        tradeCount: dayPositions.length,
      });
    }

    return returns;
  }
}
