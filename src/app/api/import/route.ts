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
 * The import is synchronous and can take several minutes for accounts
 * with large trade histories. If it becomes a problem at scale, we can
 * add job-id polling later.
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
import { setProgress } from './progress-store';

export async function POST(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    const body = await req.json().catch(() => ({}));
    const withRegimes = body.regimes !== false;
    // If a specific journalId is provided (e.g. testnet journal), newly-created
    // positions are re-assigned to that journal after grouping completes.
    const targetJournalId: string | undefined = typeof body.journalId === 'string' ? body.journalId : undefined;

    const steps: Record<string, unknown> = {};

    // 1. Ensure default journal
    const journal = await ensureDefaultJournal(walletAddress);
    steps.journal = { id: journal.id, name: journal.name };

    // Mark analyticsStatus as 'importing' before any network I/O so the
    // dashboard's poller sees the lock state the next time it ticks. The
    // full lifecycle is: 'importing' → 'computing' → 'ready'. Kept
    // wallet-wide (updateMany) because analyticsStatus is shared across
    // all journals for a wallet.
    //
    // Production TODO: if the server process is killed mid-import, this
    // value stays wedged at 'importing' and new sessions are locked out
    // of the app. A cleanup step on server startup (reset any lingering
    // 'importing'/'computing' rows to 'ready') would address this. For
    // the hackathon we accept the edge case — a manual `prisma studio`
    // toggle or a re-run of import unblocks the wallet.
    {
      const { prisma: db } = await import('@/lib/prisma');
      await db.journal.updateMany({
        where: { walletAddress },
        data: { analyticsStatus: 'importing' },
      });
    }

    // Record the start time so we can target only newly-created positions
    // when re-assigning to a non-default journal.
    const importStartedAt = new Date();

    // 2. Fetch trade history from Pacifica
    const network = req.headers.get('X-Pacifica-Network') === 'testnet' ? 'testnet' : 'mainnet';
    const apiConfigKey = network === 'testnet'
      ? (process.env.PACIFICA_TESTNET_API_KEY ?? process.env.PF_API_KEY)
      : process.env.PF_API_KEY;
    const client = new PacificaClient({ walletAddress, apiConfigKey, network });

    setProgress(walletAddress, { stage: 'fetching', message: 'Fetching trades from Pacifica…', fillsFetched: 0 });

    const fills: Awaited<ReturnType<typeof client.account.getTradeHistory>>['data'] = [];
    let cursor: string | undefined;
    do {
      const page = await client.account.getTradeHistory({ account: walletAddress, cursor });
      fills.push(...page.data);
      cursor = page.next_cursor ?? undefined;
      setProgress(walletAddress, {
        stage: 'fetching',
        message: `${fills.length} fills fetched…`,
        fillsFetched: fills.length,
      });
      if (!page.has_more) break;
    } while (cursor);

    steps.fetchedFills = fills.length;

    // 3. Deduplicate (incremental — skip fills already in DB)
    const existingIds = await getExistingFillIds(walletAddress);
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

    // 5b. Sync equity snapshots & balance events. The reconstructed equity
    //     provider (src/services/analytics/equity/reconstructed.ts) reads
    //     BalanceEvent rows to compute netCashFlows; without this sync it
    //     sees zero deposits, which makes equity go negative on the first
    //     loss and breaks Monte Carlo, Sharpe/Sortino, and the underwater
    //     curve. The CLI `src/scripts/import.ts` already does this — this
    //     block brings the HTTP import route into parity.
    //
    //     Kept non-fatal: if Pacifica rate-limits or the endpoints are
    //     temporarily down, the import still finishes with trades + funding
    //     intact. Analytics will run with degraded accuracy until the next
    //     successful sync (either a re-import or the /api/sync poller).
    setProgress(walletAddress, { stage: 'syncing', message: 'Syncing account history…', fillsFetched: fills.length });
    try {
      const { syncEquitySnapshots, syncBalanceEvents } = await import('@/services/ingestion');
      const equityResult  = await syncEquitySnapshots(walletAddress, client.account);
      const balanceResult = await syncBalanceEvents(walletAddress, client.account);
      steps.equitySnapshots = { fetched: equityResult.fetched,  upserted: equityResult.upserted };
      steps.balanceEvents   = { fetched: balanceResult.fetched, upserted: balanceResult.upserted };
    } catch (err) {
      console.error('[import] equity/balance sync failed:', err);
      steps.equitySnapshots = { error: 'Equity/balance sync failed — skipped' };
    }

    // 6. Run grouping pipeline
    setProgress(walletAddress, { stage: 'grouping', message: 'Grouping fills into positions…', fillsFetched: fills.length });
    const groupingService = new GroupingService();
    const groupingSummary = await groupingService.groupAllFills(walletAddress);
    steps.grouping = groupingSummary;

    // 6b. Re-assign newly-created positions to the target journal when a
    //     non-default journal was requested (e.g. the Testnet journal).
    if (targetJournalId && targetJournalId !== journal.id) {
      const { prisma: db } = await import('@/lib/prisma');
      await db.position.updateMany({
        where: {
          walletAddress,
          journalId: journal.id,
          createdAt: { gte: importStartedAt },
        },
        data: { journalId: targetJournalId },
      });
      steps.journalAssignment = { targetJournalId };
    }

    // 7. Split analytics compute so the user isn't blocked on the slow tier.
    //    - Fast tier (Elo, xPnL, insights, tilt) is awaited — user needs it
    //      before landing on the dashboard.
    //    - Slow tier (MFE/MAE candle fetch, regime detection + tagging) runs
    //      fire-and-forget; the dashboard banner polls `analyticsStatus` and
    //      clears itself once the background compute sets status='ready'.
    //    - Status is flipped to 'computing' BEFORE the slow tier kicks off
    //      so the banner appears as soon as the user lands on the dashboard.
    //    - Both success and failure paths reset status to 'ready' so the
    //      banner never gets stuck. (A dedicated 'failed' state would be
    //      nicer but for a single-user hackathon 'ready' is sufficient.)
    const { prisma: statusDb } = await import('@/lib/prisma');
    setProgress(walletAddress, { stage: 'computing', message: 'Computing analytics…', fillsFetched: fills.length });
    try {
      const { runCompute } = await import('@/services/compute-policy');

      // Fast tier — awaited.
      const fastResult = await runCompute(walletAddress, 'mutation', journal.id);

      // Mark slow tier in-flight before we release the response.
      await statusDb.journal.updateMany({
        where: { walletAddress },
        data: { analyticsStatus: 'computing' },
      });

      // Slow tier — fire and forget. Not awaited. Status reset to 'ready' in
      // both .then and .catch so the banner always clears eventually.
      runCompute(walletAddress, 'staleData', journal.id)
        .catch((err) => console.error('[import] slow-tier compute failed:', err))
        .finally(async () => {
          try {
            await statusDb.journal.updateMany({
              where: { walletAddress },
              data: { analyticsStatus: 'ready' },
            });
          } catch (err) {
            console.error('[import] failed to reset analyticsStatus:', err);
          }
        });

      steps.compute = { ran: fastResult.ran, slowTier: 'dispatched' };
    } catch (err) {
      console.error('[import] Fast analytics compute failed:', err);
      steps.compute = { error: 'Analytics compute failed — skipped' };
      // If fast tier threw we never flipped status to 'computing', so nothing
      // to reset. Just make sure we don't leave a stale 'computing' from a
      // prior run wedged on the record.
      await statusDb.journal.updateMany({
        where: { walletAddress },
        data: { analyticsStatus: 'ready' },
      }).catch(() => {});
    }

    // 8. Regime tagging opt-in — runCompute's slow tier now handles BTC proxy
    // regime computation + trade tagging, so this block is redundant in the
    // default import path. Still honoured when explicitly requested so the
    // route stays backwards-compatible with scripts that pass { regimes: true }.
    if (withRegimes) {
      setProgress(walletAddress, { stage: 'regimes', message: 'Detecting market regimes…', fillsFetched: fills.length });
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

    // 9. ELFA social enrichment — fire-and-forget, never blocks the import
    import('@/services/elfa/elfa-service')
      .then(async ({ getTokenSocialContext }) => {
        const { prisma: db } = await import('@/lib/prisma');
        const unenriched = await db.position.findMany({
          where: { walletAddress, socialMentions: null },
          select: { id: true, asset: true },
        });
        // Group by asset so one cached API call covers all positions on that asset
        const byAsset = new Map<string, string[]>();
        for (const p of unenriched) {
          if (!byAsset.has(p.asset)) byAsset.set(p.asset, []);
          byAsset.get(p.asset)!.push(p.id);
        }
        for (const [asset, ids] of byAsset) {
          const ctx = await getTokenSocialContext(asset).catch(() => null);
          if (!ctx) continue;
          await db.position.updateMany({
            where: { id: { in: ids } },
            data: {
              socialSentiment: ctx.sentimentScore,
              socialMentions: ctx.mentionCount,
              socialMindshare: ctx.mindshare,
            },
          });
        }
      })
      .catch((err) => console.warn('[import] ELFA enrichment failed:', err));

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

    setProgress(walletAddress, { stage: 'done', message: summary.message, fillsFetched: fills.length });

    return NextResponse.json({ summary, steps });
  });
}
