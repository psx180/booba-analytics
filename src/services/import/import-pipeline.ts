/**
 * Shared import pipeline used by both:
 *   - POST /api/import           (authenticated dashboard import)
 *   - POST /api/report/generate  (public report generation)
 *
 * Steps mirror the original route:
 *   1. Ensure default journal
 *   2. Fetch trade history from Pacifica
 *   3. Deduplicate against existing fills
 *   4. Ingest trades
 *   5. Fetch + ingest funding history
 *   5b. Sync equity snapshots & balance events
 *   6. Run grouping pipeline
 *   6b. Re-assign positions to a target journal (optional)
 *   7. Compute fast analytics (always awaited)
 *      Compute slow analytics (awaited or fire-and-forget — see options)
 *   8. Optional regime computation + tagging
 *   9. ELFA social enrichment (always fire-and-forget)
 *
 * The single behavioural knob is `awaitSlowTier`:
 *   - false (default, used by /api/import): slow tier is dispatched and the
 *     function returns immediately so the user lands on the dashboard fast.
 *   - true (used by /api/report/generate): slow tier is awaited so the report
 *     reflects every metric (regime stats, MFE/MAE, etc.).
 */

import { PacificaClient } from '@/services/pacifica';
import {
  ingestTrades,
  ingestFunding,
  syncOrders,
  getExistingFillIds,
  filterNewFills,
} from '@/services/ingestion';
import { ensureDefaultJournal } from '@/lib/journals';
import { GroupingService } from '@/services/grouping';
import { setProgress } from '@/app/api/import/progress-store';

export interface RunImportPipelineOptions {
  /** When true, the slow analytics tier is awaited rather than fire-and-forget. */
  awaitSlowTier?: boolean;
  /** When true, run the legacy regime computation step. Default true. */
  withRegimes?: boolean;
  /** Re-assign newly-created positions to this journal after grouping. */
  targetJournalId?: string;
  /** Pacifica network. Default 'mainnet'. */
  network?: 'mainnet' | 'testnet';
}

export interface ImportPipelineResult {
  summary: {
    totalFills: number;
    newFills: number;
    totalPositions: number;
    message: string;
  };
  steps: Record<string, unknown>;
}

export async function runImportPipeline(
  walletAddress: string,
  options: RunImportPipelineOptions = {},
): Promise<ImportPipelineResult> {
  const {
    awaitSlowTier = false,
    withRegimes = true,
    targetJournalId,
    network = 'mainnet',
  } = options;

  const steps: Record<string, unknown> = {};

  // 1. Ensure default journal
  const journal = await ensureDefaultJournal(walletAddress);
  steps.journal = { id: journal.id, name: journal.name };

  // Mark analyticsStatus as 'importing' before any network I/O so the
  // dashboard's poller sees the lock state the next time it ticks.
  // Lifecycle: 'importing' → 'computing' → 'ready'. Wallet-wide because
  // analyticsStatus is shared across all journals for a wallet.
  {
    const { prisma: db } = await import('@/lib/prisma');
    await db.journal.updateMany({
      where: { walletAddress },
      data: { analyticsStatus: 'importing' },
    });
  }

  const importStartedAt = new Date();

  // 2. Fetch trade history
  const apiConfigKey = network === 'testnet'
    ? (process.env.PACIFICA_TESTNET_API_KEY ?? process.env.PF_API_KEY)
    : process.env.PF_API_KEY;
  const client = new PacificaClient({ walletAddress, apiConfigKey, network });

  setProgress(walletAddress, {
    stage: 'fetching',
    message: 'Fetching trades from Pacifica…',
    fillsFetched: 0,
  });

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

  // 3. Deduplicate
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

  // 4b. Fetch + upsert order history. Slots between trade ingest and funding
  //     so Trade.orderId is already populated when downstream code wants to
  //     join trades to orders. Non-fatal — orders are an enrichment, not the
  //     source of truth for fills.
  setProgress(walletAddress, {
    stage: 'fetching_orders',
    message: 'Fetching order history…',
    fillsFetched: fills.length,
  });
  try {
    const ordersResult = await syncOrders(walletAddress, client.orders);
    steps.orders = {
      fetched: ordersResult.fetched,
      upserted: ordersResult.upserted,
      errors: ordersResult.errors.length,
    };
  } catch (err) {
    console.error('[import] order history sync failed:', err);
    steps.orders = { error: 'Order history sync failed — skipped' };
  }

  // 5. Fetch + ingest funding history (non-fatal)
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
    steps.funding = { error: 'Funding history fetch failed — skipped' };
  }

  // 5b. Sync equity snapshots + balance events. Reconstructed equity reads
  //     these to compute netCashFlows; without them Sharpe/Sortino/Monte Carlo
  //     break on the first loss.
  setProgress(walletAddress, {
    stage: 'syncing',
    message: 'Syncing account history…',
    fillsFetched: fills.length,
  });
  let balanceEventsCount: number | undefined;
  let equitySnapshotsCount: number | undefined;
  try {
    const { syncEquitySnapshots, syncBalanceEvents } = await import('@/services/ingestion');
    const equityResult  = await syncEquitySnapshots(walletAddress, client.account);
    const balanceResult = await syncBalanceEvents(walletAddress, client.account);
    balanceEventsCount   = balanceResult.fetched;
    equitySnapshotsCount = equityResult.fetched;
    steps.equitySnapshots = { fetched: equityResult.fetched,  upserted: equityResult.upserted };
    steps.balanceEvents   = { fetched: balanceResult.fetched, upserted: balanceResult.upserted };
    setProgress(walletAddress, {
      stage: 'syncing',
      message: `${balanceResult.fetched} balance events, ${equityResult.fetched} equity snapshots`,
      fillsFetched: fills.length,
      balanceEvents: balanceResult.fetched,
      equitySnapshots: equityResult.fetched,
    });
  } catch (err) {
    console.error('[import] equity/balance sync failed:', err);
    steps.equitySnapshots = { error: 'Equity/balance sync failed — skipped' };
  }

  // 6. Grouping
  setProgress(walletAddress, {
    stage: 'grouping',
    message: 'Grouping fills into positions…',
    fillsFetched: fills.length,
    balanceEvents: balanceEventsCount,
    equitySnapshots: equitySnapshotsCount,
  });
  const groupingService = new GroupingService();
  const groupingSummary = await groupingService.groupAllFills(walletAddress);
  steps.grouping = groupingSummary;
  const totalPositions = (groupingSummary as { totalPositions?: number }).totalPositions ?? 0;
  setProgress(walletAddress, {
    stage: 'grouping',
    message: `${totalPositions} positions created`,
    fillsFetched: fills.length,
    balanceEvents: balanceEventsCount,
    equitySnapshots: equitySnapshotsCount,
    positionsCreated: totalPositions,
  });

  // 6b. Re-assign newly-created positions to a non-default journal if requested.
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

  // 6c. Enrich positions with stop/TP/entry-type metadata from the Order
  //     table. Runs once per import — touches every position for the wallet so
  //     stops moved or replaced after a previous import get refreshed.
  setProgress(walletAddress, {
    stage: 'enriching',
    message: 'Linking positions to stops and targets…',
    fillsFetched: fills.length,
    balanceEvents: balanceEventsCount,
    equitySnapshots: equitySnapshotsCount,
    positionsCreated: totalPositions,
  });
  try {
    const { enrichPositionsFromOrders } = await import('@/services/enrichment/positions-from-orders');
    const enrichResult = await enrichPositionsFromOrders(walletAddress);
    steps.enrichment = {
      considered: enrichResult.positionsConsidered,
      updated: enrichResult.positionsUpdated,
      errors: enrichResult.errors.length,
    };
  } catch (err) {
    console.error('[import] position enrichment failed:', err);
    steps.enrichment = { error: 'Position enrichment failed — skipped' };
  }

  // 7. Analytics — fast tier always awaited.
  //    Slow tier is fire-and-forget for the dashboard import (awaitSlowTier=false)
  //    or awaited for report generation (awaitSlowTier=true).
  const { prisma: statusDb } = await import('@/lib/prisma');
  setProgress(walletAddress, {
    stage: 'computing',
    message: 'Computing analytics…',
    fillsFetched: fills.length,
    balanceEvents: balanceEventsCount,
    equitySnapshots: equitySnapshotsCount,
    positionsCreated: totalPositions,
    computingTier: 'fast',
  });
  try {
    const { runCompute } = await import('@/services/compute-policy');

    const fastResult = await runCompute(walletAddress, 'mutation', journal.id);

    await statusDb.journal.updateMany({
      where: { walletAddress },
      data: { analyticsStatus: 'computing' },
    });

    const slowPromise = runCompute(walletAddress, 'staleData', journal.id)
      .catch((err) => {
        console.error('[import] slow-tier compute failed:', err);
      })
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

    if (awaitSlowTier) {
      setProgress(walletAddress, {
        stage: 'computing',
        message: 'Computing deep analytics…',
        fillsFetched: fills.length,
        balanceEvents: balanceEventsCount,
        equitySnapshots: equitySnapshotsCount,
        positionsCreated: totalPositions,
        computingTier: 'slow',
      });
      await slowPromise;
      steps.compute = { ran: fastResult.ran, slowTier: 'awaited' };
    } else {
      steps.compute = { ran: fastResult.ran, slowTier: 'dispatched' };
    }
  } catch (err) {
    console.error('[import] Fast analytics compute failed:', err);
    steps.compute = { error: 'Analytics compute failed — skipped' };
    await statusDb.journal.updateMany({
      where: { walletAddress },
      data: { analyticsStatus: 'ready' },
    }).catch(() => {});
  }

  // 8. Optional explicit regime tagging (back-compat with scripts that pass
  //    { regimes: true } — runCompute's slow tier already covers BTC proxy
  //    regimes + tagging in the default path).
  if (withRegimes) {
    setProgress(walletAddress, {
      stage: 'regimes',
      message: 'Detecting market regimes…',
      fillsFetched: fills.length,
      balanceEvents: balanceEventsCount,
      equitySnapshots: equitySnapshotsCount,
      positionsCreated: totalPositions,
    });
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

  // 9. ELFA social enrichment — always fire-and-forget, never blocks.
  import('@/services/elfa/elfa-service')
    .then(async ({ getTokenSocialContext }) => {
      const { prisma: db } = await import('@/lib/prisma');
      const unenriched = await db.position.findMany({
        where: { walletAddress, socialMentions: null },
        select: { id: true, asset: true },
      });
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

  // Build summary
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

  setProgress(walletAddress, {
    stage: 'done',
    message: summary.message,
    fillsFetched: fills.length,
    balanceEvents: balanceEventsCount,
    equitySnapshots: equitySnapshotsCount,
    positionsCreated: totalPositions,
  });

  return { summary, steps };
}
