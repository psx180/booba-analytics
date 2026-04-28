import { NextRequest, NextResponse } from 'next/server';
import { createAnalyticsService } from '@/services/analytics';
import { resolveJournalFilterId } from '@/lib/journals';
import { parseFilters } from '../_filters';
import { withAuth } from '@/lib/api-auth';
import { prisma } from '@/lib/prisma';

export async function GET(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
  const sp = req.nextUrl.searchParams;

  const service = createAnalyticsService();
  const filters = parseFilters(sp);
  // Resolve journal scope. Default journal returns id=null → wallet-wide view.
  const journalRes = await resolveJournalFilterId(walletAddress, sp.get('journalId'));
  if (!journalRes.valid) {
    return NextResponse.json({ error: 'Journal not found for this wallet' }, { status: 404 });
  }
  if (journalRes.id) filters.journalId = journalRes.id;

  // Compose the full advanced summary so the dashboard only needs one fetch
  // to populate every stat card. The performance result keeps the legacy
  // top-level shape (`data`, `breakdowns`) the existing client expects;
  // additional results are nested under their own keys.
  const liquidationScope = {
    walletAddress,
    status: 'closed',
    tradeType: 'liquidated',
    ...(journalRes.id ? { journalId: journalRes.id } : {}),
  };

  const [summary, missingExitCount, liquidationAgg] = await Promise.all([
    service.getAdvancedSummary(walletAddress, filters),
    (prisma as any).position.count({
      where: {
        walletAddress,
        status: 'closed',
        mfePnl: null,
        ...(journalRes.id ? { journalId: journalRes.id } : {}),
      },
    }),
    (prisma as any).position.aggregate({
      where: liquidationScope,
      _count: { id: true },
      _sum:   { aggregatePnl: true },
    }),
  ]);
  const performance = summary.performance;

  const rm = summary.riskMetrics;
  return NextResponse.json({
    ...performance,
    eloResult:               summary.eloResult,
    entropyResult:           summary.entropyResult,
    xpnlLuckScore:           summary.xpnlLuckScore,
    xpnlResult:              summary.xpnl,
    equityCurveConsistency:  summary.equityCurveConsistency,
    wartResult:              summary.wartResult,
    missingExitMetricsCount: missingExitCount as number,
    liquidationCount: (liquidationAgg._count.id as number) ?? 0,
    liquidationCost:  Math.round(((liquidationAgg._sum.aggregatePnl as number) ?? 0) * 100) / 100,
    sharpeRatio:             rm.sharpeRatio,
    sortinoRatio:            rm.sortinoRatio,
    calmarRatio:             rm.calmarRatio,
    usingDailyMetrics:       rm.usingDailyMetrics,
    dailyObservationCount:   rm.dailyObservationCount,
    perTradeSharpe:          rm.perTradeSharpe,
    perTradeSortino:         rm.perTradeSortino,
    perTradeCalmar:          rm.perTradeCalmar,
    dailySharpe:             rm.dailySharpe,
    dailySortino:            rm.dailySortino,
    dailyCalmar:             rm.dailyCalmar,
    ulcerIndex:              rm.ulcerIndex,
    maxDrawdownDurationDays: rm.maxDrawdownDurationDays,
    avgDrawdownPct:          rm.avgDrawdownPct,
    payoffRatio:             rm.payoffRatio,
    recoveryFactor:          rm.recoveryFactor,
    drawdownAnalysis:        rm.drawdownAnalysis,
    feeAttribution:          rm.feeAttribution,
    // Hidden — MAE-based R-multiple is non-standard; needs stop-loss data for proper Van Tharp R
    avgRMultiple:            null,
    rMultipleDistribution:   null,
    riskTradeCount:          rm.tradeCount,
  });
  });
}