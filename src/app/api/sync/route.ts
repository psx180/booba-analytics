/**
 * POST /api/sync
 *
 * Belt-and-suspenders fallback for the websocket: fetches any fills from
 * the Pacifica REST API that arrived since the most recent fill already in
 * the DB, then ingests + incrementally groups them using the same pipeline
 * as fill-handler.ts.
 *
 * Called by:
 *   - usePacificaLive polling (every 60 seconds, silent)
 *   - TradesClient / DashboardClient on page mount (one-shot)
 *   - Manual "Sync" button on the Trades page
 *
 * Returns: { found: number, imported: number, alreadyExists: number }
 *   found        — total fills returned from Pacifica since the start window
 *   imported     — fills that were new and inserted into the DB
 *   alreadyExists — fills already in the DB (deduped by history_id)
 */

import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { PacificaClient } from '@/services/pacifica';
import { PacificaAuthError } from '@/services/pacifica/errors';
import { ingestTrades, syncBalanceEvents, syncEquitySnapshots } from '@/services/ingestion';
import { fillId } from '@/services/ingestion/mapper';
import { GroupingService } from '@/services/grouping';
import { prisma } from '@/lib/prisma';

const groupingService = new GroupingService();

// Equity snapshots and balance events update on slower cadences than fills —
// there's no value in refetching them on every 60-second poll. Throttle to
// once per wallet per 30 minutes; the trade-sync path stays unthrottled so
// fills still land immediately.
const EQUITY_SYNC_INTERVAL_MS = 30 * 60 * 1000;
const lastEquitySyncMs = new Map<string, number>();

export async function POST(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    // 1. Find the most recent fill timestamp in the DB.
    //    Open fills store their time in entryTime; close fills in exitTime.
    const agg = await prisma.trade.aggregate({
      where: { walletAddress },
      _max: { exitTime: true, entryTime: true },
    });

    const lastExitMs = agg._max.exitTime?.getTime() ?? 0;
    const lastEntryMs = agg._max.entryTime?.getTime() ?? 0;
    const lastFillMs = Math.max(lastExitMs, lastEntryMs);

    const networkHeader = req.headers.get('X-Pacifica-Network');
    const network = networkHeader === 'testnet' ? 'testnet' : 'mainnet';
    const apiConfigKey = network === 'testnet'
      ? (process.env.PACIFICA_TESTNET_API_KEY ?? process.env.PF_API_KEY)
      : process.env.PF_API_KEY;
    const client = new PacificaClient({ walletAddress, apiConfigKey, network });

    // Equity snapshots and balance events are independent of fills — they
    // change with deposits, withdrawals, mark-price moves, etc. Fire them
    // off as soon as the client is built so they run on every /api/sync
    // call (including the no-new-fills fast paths below). Required by the
    // snapshot-twr equity provider. Throttled per wallet to avoid re-fetching
    // the full balance-event cursor chain on every 60-second poll.
    const now = Date.now();
    const lastSync = lastEquitySyncMs.get(walletAddress) ?? 0;
    if (now - lastSync > EQUITY_SYNC_INTERVAL_MS) {
      lastEquitySyncMs.set(walletAddress, now);
      syncEquitySnapshots(walletAddress, client.account).catch((err) =>
        console.error('[sync] syncEquitySnapshots failed', err),
      );
      syncBalanceEvents(walletAddress, client.account).catch((err) =>
        console.error('[sync] syncBalanceEvents failed', err),
      );
    }

    if (lastFillMs === 0) {
      // No existing fills — nothing to sync from (user hasn't imported yet).
      return NextResponse.json({ found: 0, imported: 0, alreadyExists: 0 });
    }

    // 2. Fetch fills from Pacifica since that timestamp.
    //    Use a 60-second buffer to catch fills that arrived slightly out of
    //    order or at the same millisecond as the last known fill. Dedup
    //    by fillId handles any overlap cleanly.
    const startTime = Math.max(0, lastFillMs - 60_000);

    let fills;
    try {
      fills = await client.account.getAllTradeHistory({
        account: walletAddress,
        startTime,
      });
    } catch (err) {
      if (err instanceof PacificaAuthError) {
        return NextResponse.json({ error: 'auth', message: 'API key not accepted for this network' });
      }
      console.error('[sync] Pacifica fetch failed', err);
      return NextResponse.json({ found: 0, imported: 0, alreadyExists: 0 });
    }

    const found = fills.length;
    if (found === 0) {
      return NextResponse.json({ found: 0, imported: 0, alreadyExists: 0 });
    }

    // 3. Targeted dedup: look up only the IDs returned by the API rather
    //    than scanning the entire fills table (getExistingFillIds scans all).
    const fillIds = fills.map(fillId);
    const existing = await prisma.trade.findMany({
      where: { id: { in: fillIds } },
      select: { id: true },
    });
    const existingSet = new Set(existing.map((t) => t.id));
    const newFills = fills.filter((f) => !existingSet.has(fillId(f)));
    const alreadyExists = found - newFills.length;

    if (newFills.length === 0) {
      return NextResponse.json({ found, imported: 0, alreadyExists });
    }

    // 4. Ingest all new fills at once (same mapper as the full import route).
    const ingestResult = await ingestTrades(newFills, walletAddress);
    const imported = ingestResult.tradesUpserted;

    // 5. Detect network from header and resolve target journal for new positions.
    //    Testnet fills must land in the Testnet journal, not the default journal.
    let syncJournalId: string | undefined;
    if (network === 'testnet') {
      let testnetJournal = await prisma.journal.findFirst({
        where: { walletAddress, name: 'Testnet' },
      });
      if (!testnetJournal) {
        testnetJournal = await prisma.journal.create({
          data: { walletAddress, name: 'Testnet' },
        });
      }
      syncJournalId = testnetJournal.id;
    }

    // Incrementally group each new fill (mutex inside groupNewFill serializes per wallet).
    for (const fill of newFills) {
      try {
        await groupingService.groupNewFill(walletAddress, fillId(fill), syncJournalId);
      } catch (err) {
        console.error('[sync] groupNewFill failed for', fillId(fill), err);
      }
    }

    // 6. Fire-and-forget fast-tier analytics recompute.
    import('@/services/compute-policy')
      .then(({ runCompute }) =>
        runCompute(walletAddress, 'mutation').catch((err) =>
          console.error('[sync] runCompute failed', err),
        ),
      )
      .catch(() => {});

    return NextResponse.json({ found, imported, alreadyExists });
  });
}
