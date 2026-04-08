/**
 * ingestion/index.ts
 *
 * Orchestrates the full data pipeline:
 *   Pacifica API → mapper → grouper → Prisma DB
 *
 * Two main functions:
 *
 *   ingestHistoricalTrades() — bulk import of all fills + trade grouping.
 *     Called once on first setup, or to backfill missing history.
 *
 *   ingestFundingHistory() — import funding payments and link them to the
 *     trades that were open during each payment. Updates trades with
 *     accumulated fundingEarned / fundingPaid.
 *
 * Design rules:
 *   - This layer never calls the Pacifica API directly. It receives raw data.
 *   - This layer never constructs analytics. It only writes raw + grouped data.
 *   - Ingestion is idempotent: re-running it upserts, never duplicates.
 */

import type { AccountFundingEntry, TradeHistoryEntry } from '../pacifica/types/account';
import { prisma } from '../../lib/prisma';
import { buildGroups, type GroupingStrategy } from './grouper';
import { fillId, mapFillToTrade } from './mapper';

// ─── Result types ─────────────────────────────────────────────────────────────

export interface IngestTradesResult {
  fillsProcessed: number;
  tradesUpserted: number;
  groupsUpserted: number;
  openPositions: number;
  skipped: number;
  errors: string[];
}

export interface IngestFundingResult {
  eventsProcessed: number;
  eventsLinked: number;
  eventsUnlinked: number;
  errors: string[];
}

// ─── Trade ingestion ──────────────────────────────────────────────────────────

/**
 * Ingest raw fills from Pacifica into the database.
 *
 * @param fills      Raw fill array from client.account.getAllTradeHistory()
 * @param strategy   Optional custom grouping strategy (defaults to FIFO)
 */
export async function ingestTrades(
  fills: TradeHistoryEntry[],
  strategy?: GroupingStrategy,
): Promise<IngestTradesResult> {
  const result: IngestTradesResult = {
    fillsProcessed: 0,
    tradesUpserted: 0,
    groupsUpserted: 0,
    openPositions: 0,
    skipped: 0,
    errors: [],
  };

  if (fills.length === 0) return result;
  result.fillsProcessed = fills.length;

  // Step 1: Map all fills → TradeCreateInput
  const mappedFills = fills.map(mapFillToTrade);

  // Step 2: Group fills → assign groupIds, create TradeGroup records
  const { updatedTrades, groups } = buildGroups(mappedFills, strategy);
  result.openPositions = groups.filter((g) => g.status === 'open').length;

  // Step 3: Upsert TradeGroups first (trades reference them via groupId FK)
  for (const group of groups) {
    try {
      await prisma.tradeGroup.upsert({
        where: { id: group.id },
        create: {
          id: group.id,
          asset: group.asset,
          direction: group.direction,
          status: group.status,
          tradeType: group.tradeType ?? null,
          totalSize: group.totalSize,
          averageEntryPrice: group.averageEntryPrice,
          averageExitPrice: group.averageExitPrice ?? null,
          aggregatePnl: group.aggregatePnl ?? null,
          aggregateFees: group.aggregateFees ?? null,
          aggregateFunding: group.aggregateFunding ?? null,
          createdAt: group.createdAt,
          updatedAt: group.updatedAt,
        },
        update: {
          status: group.status,
          averageExitPrice: group.averageExitPrice ?? null,
          aggregatePnl: group.aggregatePnl ?? null,
          aggregateFees: group.aggregateFees ?? null,
          totalSize: group.totalSize,
          updatedAt: new Date(),
        },
      });
      result.groupsUpserted++;
    } catch (err) {
      result.errors.push(`Group ${group.id}: ${String(err)}`);
    }
  }

  // Step 4: Upsert Trade records
  for (const trade of updatedTrades) {
    try {
      await prisma.trade.upsert({
        where: { id: trade.id },
        create: {
          id: trade.id,
          asset: trade.asset,
          direction: trade.direction,
          size: trade.size,
          entryPrice: trade.entryPrice,
          exitPrice: trade.exitPrice ?? null,
          entryTime: trade.entryTime ?? new Date(0),
          exitTime: trade.exitTime ?? null,
          pnlRealized: trade.pnlRealized ?? null,
          fees: trade.fees ?? null,
          holdTimeSeconds: trade.holdTimeSeconds ?? null,
          captureMode: trade.captureMode,
          tradeType: trade.tradeType ?? null,
          groupId: trade.groupId ?? null,
          fundingEarned: null,
          fundingPaid: null,
          rawData: trade.rawData,
          createdAt: trade.createdAt,
          updatedAt: trade.updatedAt,
        },
        update: {
          groupId: trade.groupId ?? null,
          exitPrice: trade.exitPrice ?? null,
          exitTime: trade.exitTime ?? null,
          entryTime: trade.entryTime ?? undefined,
          pnlRealized: trade.pnlRealized ?? null,
          holdTimeSeconds: trade.holdTimeSeconds ?? null,
          updatedAt: new Date(),
        },
      });
      result.tradesUpserted++;
    } catch (err) {
      result.errors.push(`Trade ${trade.id}: ${String(err)}`);
      result.skipped++;
    }
  }

  return result;
}

// ─── Funding history ingestion ────────────────────────────────────────────────

/**
 * Ingest funding payments from Pacifica into the database.
 *
 * Attempts to link each funding event to the trade that was open at the
 * time of the payment (same asset, overlapping time window). Updates the
 * matched trade's fundingEarned / fundingPaid accordingly.
 *
 * @param events   Raw funding events from client.account.getFundingHistory()
 */
export async function ingestFunding(
  events: AccountFundingEntry[],
): Promise<IngestFundingResult> {
  const result: IngestFundingResult = {
    eventsProcessed: 0,
    eventsLinked: 0,
    eventsUnlinked: 0,
    errors: [],
  };

  if (events.length === 0) return result;
  result.eventsProcessed = events.length;

  for (const event of events) {
    try {
      const eventTime = new Date(event.created_at);
      const payout = parseFloat(event.payout);

      // Try to find the trade that was open during this funding event:
      // same asset, entered before the event, exited after (or still open)
      const matchedTrade = await prisma.trade.findFirst({
        where: {
          asset: event.symbol,
          entryTime: { lte: eventTime },
          OR: [
            { exitTime: null },
            { exitTime: { gte: eventTime } },
          ],
        },
        orderBy: { entryTime: 'desc' },
      });

      // Write the funding event
      await prisma.fundingHistory.upsert({
        where: { id: `funding_${event.history_id}` },
        create: {
          id: `funding_${event.history_id}`,
          asset: event.symbol,
          amount: parseFloat(event.amount),
          rate: parseFloat(event.rate),
          timestamp: eventTime,
          tradeId: matchedTrade?.id ?? null,
          rawData: JSON.stringify(event),
        },
        update: {
          tradeId: matchedTrade?.id ?? null,
        },
      });

      if (matchedTrade) {
        // Accumulate funding onto the matched trade
        // Positive payout = earned (we received), negative = paid (we paid)
        if (payout >= 0) {
          await prisma.trade.update({
            where: { id: matchedTrade.id },
            data: {
              fundingEarned: { increment: payout },
              updatedAt: new Date(),
            },
          });
        } else {
          await prisma.trade.update({
            where: { id: matchedTrade.id },
            data: {
              fundingPaid: { increment: Math.abs(payout) },
              updatedAt: new Date(),
            },
          });
        }
        result.eventsLinked++;
      } else {
        result.eventsUnlinked++;
      }
    } catch (err) {
      result.errors.push(`Funding event ${event.history_id}: ${String(err)}`);
    }
  }

  // Update TradeGroup aggregate funding from their constituent trades
  await rollUpGroupFunding();

  return result;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * After funding ingestion, roll up funding totals from trades onto their groups.
 */
async function rollUpGroupFunding(): Promise<void> {
  const groups = await prisma.tradeGroup.findMany({
    where: { trades: { some: { OR: [{ fundingEarned: { gt: 0 } }, { fundingPaid: { gt: 0 } }] } } },
    include: { trades: { select: { fundingEarned: true, fundingPaid: true } } },
  });

  for (const group of groups) {
    const totalFunding = group.trades.reduce((sum: number, t: { fundingEarned: number | null; fundingPaid: number | null }) => {
      return sum + (t.fundingEarned ?? 0) - (t.fundingPaid ?? 0);
    }, 0);

    await prisma.tradeGroup.update({
      where: { id: group.id },
      data: { aggregateFunding: totalFunding, updatedAt: new Date() },
    });
  }
}

/**
 * Check which fill IDs are already in the database.
 * Use this to avoid re-fetching history you've already ingested.
 */
export async function getExistingFillIds(): Promise<Set<string>> {
  const trades = await prisma.trade.findMany({
    where: { id: { startsWith: 'pacifica_fill_' } },
    select: { id: true },
  });
  return new Set(trades.map((t) => t.id));
}

/**
 * Filter a fill array down to only fills not yet in the database.
 */
export function filterNewFills(
  fills: TradeHistoryEntry[],
  existingIds: Set<string>,
): TradeHistoryEntry[] {
  return fills.filter((f) => !existingIds.has(fillId(f)));
}
