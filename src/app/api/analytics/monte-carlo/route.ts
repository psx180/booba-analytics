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

    // Equity-based per-trade returns: pnlPct = aggregatePnl / equityAtEntry * 100,
    // where equityAtEntry is startingCapital + cumulative P&L of all prior
    // (chronologically earlier) closed trades. This is the same basis used
    // by Sharpe/Sortino in src/services/analytics/equity/reconstructed.ts —
    // on leveraged perps, notional-based returns compress wildly toward
    // zero (e.g. a $500 loss on $50k notional reads as -1%) and make the
    // Monte Carlo unable to produce realistic drawdowns. Equity-based
    // returns reflect actual capital impact: that same $500 loss against
    // $5k equity is a -10% draw.
    const startingCapital = await defaultEquityProvider.getStartingCapital(walletAddress);

    // Chronological sort so cumulative P&L is built in trade order. Prefer
    // lastExitTime (when the position realized its P&L) with firstEntryTime
    // as a defensive fallback for legacy rows missing an exit timestamp.
    const sorted = [...positions].sort((a: any, b: any) => {
      const ta = a.lastExitTime ?? a.firstEntryTime ?? 0;
      const tb = b.lastExitTime ?? b.firstEntryTime ?? 0;
      return new Date(ta).getTime() - new Date(tb).getTime();
    });

    const winReturnPcts: number[] = [];
    const lossReturnPcts: number[] = [];
    let grossWins  = 0;
    let grossLosses = 0;
    let validCount = 0;
    let clampedCount = 0;
    let cumulativePnl = 0;

    for (const p of sorted) {
      const pnl: number = p.aggregatePnl ?? 0;
      const equityAtEntry = startingCapital + cumulativePnl;
      // Update cumulative P&L *after* capturing equity-at-entry so this
      // trade's own P&L isn't counted in its own denominator.
      cumulativePnl += pnl;

      // Skip when equity is zero/negative — would yield divide-by-zero or
      // sign-flipped returns. In practice this only fires if the wallet's
      // starting-capital anchor is wrong or the account went bust.
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
