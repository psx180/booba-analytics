import type { Position } from '../aggregations/base';
import type { EquitySourceProvider, EquityPoint, DailyReturn } from './types';

// Wraps the pre-existing equity-curve behavior bit-for-bit, including the
// Math.max(Math.abs(hwm), 1) denominator that produces absurd drawdown
// percentages when hwm is small. Do not "fix" anything here — parity with
// the legacy aggregator is the point.
export class LegacyPnlBasedProvider implements EquitySourceProvider {
  name = 'legacy-pnl-based';

  async getStartingCapital(_walletAddress: string): Promise<number> {
    return 0;
  }

  async getEquityCurve(
    _walletAddress: string,
    positions: Position[],
  ): Promise<EquityPoint[]> {
    const closed = positions
      .filter(
        (p) => p.status === 'closed' && p.aggregatePnl != null && p.lastExitTime != null,
      )
      .sort((a, b) => a.lastExitTime!.getTime() - b.lastExitTime!.getTime());

    let cumulative = 0;
    let hwm = 0;
    const series: EquityPoint[] = [];

    for (const p of closed) {
      cumulative += p.aggregatePnl ?? 0;
      if (cumulative > hwm) hwm = cumulative;

      const underwater = cumulative - hwm;
      const denom = Math.max(Math.abs(hwm), 1);
      const underwaterPct = (underwater / denom) * 100;

      series.push({
        timestamp: p.lastExitTime!,
        equity: cumulative,
        cumulativePnl: cumulative,
        peakEquity: hwm,
        underwaterPct,
        underwaterDollars: underwater,
        regime: p.regimeAtEntry ?? null,
      });
    }

    return series;
  }

  async getDailyReturns(
    _walletAddress: string,
    positions: Position[],
  ): Promise<DailyReturn[]> {
    const closed = positions
      .filter(
        (p) => p.status === 'closed' && p.aggregatePnl != null && p.lastExitTime != null,
      )
      .sort((a, b) => a.lastExitTime!.getTime() - b.lastExitTime!.getTime());

    const byDate = new Map<string, Position[]>();
    for (const pos of closed) {
      const dateStr = pos.lastExitTime!.toISOString().split('T')[0];
      if (!byDate.has(dateStr)) byDate.set(dateStr, []);
      byDate.get(dateStr)!.push(pos);
    }

    let cumulative = 0;
    const returns: DailyReturn[] = [];

    for (const date of [...byDate.keys()].sort()) {
      const dayPositions = byDate.get(date)!;
      const dayPnl = dayPositions.reduce((sum, p) => sum + (p.aggregatePnl ?? 0), 0);
      const equityAtStart = cumulative;
      cumulative += dayPnl;

      returns.push({
        date,
        pnl: dayPnl,
        returnPct: dayPnl,
        equityAtStart,
        equityAtEnd: cumulative,
        cashFlows: 0,
        tradeCount: dayPositions.length,
      });
    }

    return returns;
  }
}
