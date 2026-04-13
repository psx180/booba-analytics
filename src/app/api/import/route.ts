/**
 * POST /api/import
 *
 * Runs the trade-import pipeline for the authenticated wallet:
 *   1. Ensure default journal exists
 *   2. Fetch all trade history from Pacifica API
 *   3. Deduplicate against existing fills (incremental)
 *   4. Ingest trades into the database
 *   5. Fetch and ingest funding history
 *   6. Run the grouping pipeline (fills → orders → positions)
 *   7. Optionally compute regime tags
 *
 * This is the HTTP equivalent of `src/scripts/import.ts` — the onboarding
 * "Import Trades" button calls this endpoint.
 *
 * The import is synchronous: for a typical wallet with <500 fills the
 * entire pipeline completes in under 30 seconds. If it becomes a problem
 * at scale, we can add job-id polling later.
 *
 * Body (optional):
 *   { regimes?: boolean }   — whether to compute regime tags (default: true)
 */

import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { PacificaClient } from '@/services/pacifica';
import {
  ingestTrades,
  ingestFunding,
  getExistingFillIds,
  filterNewFills,
} from '@/services/ingestion';
import { ensureDefaultJournal } from '@/lib/journals';
import { GroupingService } from '@/services/grouping';

export async function POST(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    const body = await req.json().catch(() => ({}));
    const withRegimes = body.regimes !== false;

    const steps: Record<string, unknown> = {};

    // 1. Ensure default journal
    const journal = await ensureDefaultJournal(walletAddress);
    steps.journal = { id: journal.id, name: journal.name };

    // 2. Fetch trade history from Pacifica
    const apiConfigKey = process.env.PF_API_KEY;
    const client = new PacificaClient({ walletAddress, apiConfigKey });

    const fills = await client.account.getAllTradeHistory({ account: walletAddress });
    steps.fetchedFills = fills.length;

    // 3. Deduplicate (incremental — skip fills already in DB)
    const existingIds = await getExistingFillIds();
    const newFills = filterNewFills(fills, existingIds);
    steps.newFills = newFills.length;

    // 4. Ingest trades
    if (newFills.length > 0) {
      const tradeResult = await ingestTrades(newFills, walletAddress);
      steps.trades = {
        processed: tradeResult.fillsProcessed,
        upserted: tradeResult.tradesUpserted,
        skipped: tradeResult.skipped,
        errors: tradeResult.errors.length,
      };
    } else {
      steps.trades = { processed: 0, upserted: 0, skipped: 0, errors: 0 };
    }

    // 5. Fetch and ingest funding history
    try {
      const fundingPage = await client.account.getFundingHistory({ account: walletAddress });
      const fundingEvents = fundingPage.data;
      steps.fetchedFunding = fundingEvents.length;

      if (fundingEvents.length > 0) {
        const fundingResult = await ingestFunding(fundingEvents, walletAddress);
        steps.funding = {
          processed: fundingResult.eventsProcessed,
          linked: fundingResult.eventsLinked,
          unlinked: fundingResult.eventsUnlinked,
          errors: fundingResult.errors.length,
        };
      } else {
        steps.funding = { processed: 0, linked: 0, unlinked: 0, errors: 0 };
      }
    } catch {
      // Funding fetch may fail on some accounts — non-fatal
      steps.funding = { error: 'Funding history fetch failed — skipped' };
    }

    // 6. Run grouping pipeline
    const groupingService = new GroupingService();
    const groupingSummary = await groupingService.groupAllFills(walletAddress);
    steps.grouping = groupingSummary;

    // 7. Full analytics compute (fast + slow) — awaited since user is already waiting
    try {
      const { runCompute } = await import('@/services/compute-policy');
      const computeResult = await runCompute(walletAddress, 'import', journal.id);
      steps.compute = computeResult;
    } catch {
      steps.compute = { error: 'Analytics compute failed — skipped' };
    }

    // 8. Regime tagging — now redundant for BTC proxy (runCompute slow tier handles it),
    // but kept as optional override so the route stays backwards-compatible.
    if (withRegimes) {
      try {
        const { AdxAtrDetector, RegimeService } = await import('@/services/regime');
        const { getCandleCache, CacheBackedCandleSource } = await import('@/services/candles');
        const detector = new AdxAtrDetector();
        const source = new CacheBackedCandleSource(
          getCandleCache(),
          (asset) => asset.replace(/USDT$/, ''),
        );
        const regimeService = new RegimeService(detector, source);

        const end = new Date();
        const start = new Date(end.getTime() - 365 * 86_400_000);
        const { computed, skipped } = await regimeService.computeRegimes('BTCUSDT', '1d', start, end);
        const tagged = await regimeService.tagTrades();
        steps.regimes = { computed, skipped, tagged };
      } catch {
        steps.regimes = { error: 'Regime computation failed — skipped' };
      }
    }

    // Build a user-friendly summary
    const totalPositions = (groupingSummary as { totalPositions?: number }).totalPositions ?? 0;
    const assets = new Set<string>();
    // Count unique assets from the grouping summary positionsByType or from steps
    // For simplicity, report the totalPositions from grouping
    const summary = {
      totalFills: fills.length,
      newFills: newFills.length,
      totalPositions,
      message:
        totalPositions > 0
          ? `Found ${totalPositions} positions. Your trading history is ready.`
          : newFills.length === 0
          ? 'No new trades to import.'
          : 'Trades imported. Run grouping from the Trades page to create positions.',
    };

    return NextResponse.json({ summary, steps });
  });
}
