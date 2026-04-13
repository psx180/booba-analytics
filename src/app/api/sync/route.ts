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
import { ingestTrades } from '@/services/ingestion';
import { fillId } from '@/services/ingestion/mapper';
import { GroupingService } from '@/services/grouping';
import { prisma } from '@/lib/prisma';

const groupingService = new GroupingService();

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

    if (lastFillMs === 0) {
      // No existing fills — nothing to sync from (user hasn't imported yet).
      return NextResponse.json({ found: 0, imported: 0, alreadyExists: 0 });
    }

    // 2. Fetch fills from Pacifica since that timestamp.
    //    Use a 60-second buffer to catch fills that arrived slightly out of
    //    order or at the same millisecond as the last known fill. Dedup
    //    by fillId handles any overlap cleanly.
    const startTime = Math.max(0, lastFillMs - 60_000);
    const apiConfigKey = process.env.PF_API_KEY;
    const client = new PacificaClient({ walletAddress, apiConfigKey });

    let fills;
    try {
      fills = await client.account.getAllTradeHistory({
        account: walletAddress,
        startTime,
      });
    } catch (err) {
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

    // 5. Incrementally group each new fill (serialized — groupNewFill reads and
    //    writes open positions, so concurrent calls would race on the lookup).
    for (const fill of newFills) {
      try {
        await groupingService.groupNewFill(walletAddress, fillId(fill));
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
