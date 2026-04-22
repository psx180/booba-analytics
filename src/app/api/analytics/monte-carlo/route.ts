import { NextRequest, NextResponse } from 'next/server';
import { resolveJournalFilterId } from '@/lib/journals';
import { withAuth } from '@/lib/api-auth';
import { prisma } from '@/lib/prisma';
import { runMonteCarloSimulation } from '@/services/analytics/monte-carlo';
import { defaultEquityProvider } from '@/services/analytics/equity';

// Sanity cap on any single trade's equity-based return. With leverage a
// trade can in principle lose more than equity, but values beyond this
// range are almost always bad data (e.g. a position whose entry falls
// before the starting-capital anchor, producing an inflated percentage).
// Clamping keeps Monte Carlo draws from being dominated by one outlier.
const MAX_RETURN_PCT = 200;

export async function GET(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    const sp = req.nextUrl.searchParams;

    const journalRes = await resolveJournalFilterId(walletAddress, sp.get('journalId'));
    if (!journalRes.valid) {
      return NextResponse.json({ error: 'Journal not found for this wallet' }, { status: 404 });
    }

    const where: Record<string, any> = { walletAddress, status: 'closed' };
    if (journalRes.id) where.journalId = journalRes.id;

    const positions = await (prisma as any).position.findMany({
      where,
      select: {
        aggregatePnl: true,
        totalSize: true,
        averageEntryPrice: true,
        lastExitTime: true,
        firstEntryTime: true,
      },
      take: 5000,
    });

    // Equity-based per-trade returns. On leveraged perps, notional-based
    // returns compress wildly toward zero (e.g. a $500 loss on $50k notional
    // reads as -1%) and make the Monte Carlo unable to produce realistic
    // drawdowns. Equity-based returns reflect actual capital impact.
    //
    // The equity denominator comes from the reconstructed equity provider,
    // which computes equity as (Σ deposits − Σ withdrawals + Σ realized P&L)
    // at each position's close time. Crucially, this picks up *every* cash
    // flow — not just the first deposit — so wallets with ongoing deposits
    // and withdrawals get accurate per-trade denominators. Same basis used
    // by Sharpe/Sortino in src/services/analytics/equity/reconstructed.ts.
    //
    // Known minor precision tradeoff: we use equityCurve[i-1].equity as the
    // denominator for trade i, which is frozen at trade i-1's close. If a
    // deposit lands between trade i-1 and trade i, it isn't reflected in
    // that denominator. The per-trade error is small and averages out
    // across the return distribution used for sampling; a TWR-adjusted
    // denominator (see reconstructed.ts lines 88–100) would be proper but
    // is overkill for Monte Carlo input statistics.

    // Pre-filter + sort with the *same* predicate ReconstructedProvider
    // uses internally (see reconstructed.ts:55–59). This keeps `sorted`
    // and `equityCurve` aligned index-for-index so we can index into
    // both in the loop below. Without this filter, any position with a
    // null aggregatePnl or lastExitTime (legacy data, interrupted imports)
    // would be dropped by the provider but remain in `sorted`, silently
    // misaligning indices.
    const sorted = positions
      .filter((p: any) => p.aggregatePnl != null && p.lastExitTime != null)
      .sort((a: any, b: any) => new Date(a.lastExitTime).getTime() - new Date(b.lastExitTime).getTime());

    const equityCurve = await defaultEquityProvider.getEquityCurve(walletAddress, sorted);

    const winReturnPcts: number[] = [];
    const lossReturnPcts: number[] = [];
    let grossWins  = 0;
    let grossLosses = 0;
    let validCount = 0;
    let clampedCount = 0;

    for (let i = 0; i < equityCurve.length; i++) {
      const pt = equityCurve[i];
      const pnl: number = sorted[i].aggregatePnl ?? 0;

      // For the first trade we don't have a prior equity point, so recover
      // "equity just before the trade's P&L posted" by subtracting that
      // P&L back out of the current point's equity. For subsequent trades,
      // the prior point's equity is the entry-time equity (modulo the
      // known precision note above).
      const equityAtEntry = i === 0
        ? pt.equity - pnl
        : equityCurve[i - 1].equity;

      if (equityAtEntry <= 0) continue;

      let pnlPct = (pnl / equityAtEntry) * 100;

      if (Math.abs(pnlPct) > MAX_RETURN_PCT) {
        console.warn(
          `[monte-carlo] Clamping extreme return ${pnlPct.toFixed(1)}% to ±${MAX_RETURN_PCT}% ` +
          `(pnl=${pnl}, equityAtEntry=${equityAtEntry.toFixed(2)})`,
        );
        pnlPct = Math.sign(pnlPct) * MAX_RETURN_PCT;
        clampedCount++;
      }

      validCount++;

      if (pnlPct > 0) {
        winReturnPcts.push(pnlPct);
        grossWins += pnlPct;
      } else if (pnlPct < 0) {
        lossReturnPcts.push(pnlPct);
        grossLosses += Math.abs(pnlPct);
      }
      // Flat trades (pnlPct === 0) count toward validCount only
    }

    if (clampedCount > 0) {
      console.warn(`[monte-carlo] ${clampedCount} of ${validCount} trades had returns clamped to ±${MAX_RETURN_PCT}%`);
    }

    if (validCount < 20) {
      return NextResponse.json(
        { error: 'Not enough trade history for reliable simulation. Need at least 20 trades.' },
        { status: 422 },
      );
    }

    const winCount  = winReturnPcts.length;
    const lossCount = lossReturnPcts.length;
    const winRate    = winCount / validCount;
    const avgWinPct  = winCount  > 0 ? grossWins    / winCount  : 0;
    const avgLossPct = lossCount > 0 ? -(grossLosses / lossCount) : 0;
    const initialBalance = 10000;

    const result = runMonteCarloSimulation({
      winRate,
      avgWinPct,
      avgLossPct,
      tradeCount:    100,
      simulations:   10000,
      initialBalance,
      winReturnPcts:  winCount  > 0 ? winReturnPcts  : undefined,
      lossReturnPcts: lossCount > 0 ? lossReturnPcts : undefined,
    });

    return NextResponse.json({
      ...result,
      initialBalance,
      inputWinRate:    Math.round(winRate    * 10000) / 10000,
      inputAvgWinPct:  Math.round(avgWinPct  * 100)   / 100,
      inputAvgLossPct: Math.round(avgLossPct * 100)   / 100,
      inputTradeCount: validCount,
    });
  });
}
