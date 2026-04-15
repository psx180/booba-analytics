/**
 * ingestion/index.ts
 *
 * Orchestrates the data pipeline:
 *   Pacifica API → mapper → Prisma DB
 *
 * Two main functions:
 *
 *   ingestTrades() — bulk import of all fills into the trades table.
 *     Called once on first setup, or to backfill missing history.
 *     Fills are saved as raw records. The grouping pipeline
 *     (src/services/grouping/) handles grouping into orders/positions.
 *
 *   ingestFunding() — import funding payments and link them to the
 *     trades that were open during each payment.
 *
 * Design rules:
 *   - This layer never calls the Pacifica API directly. It receives raw data.
 *   - This layer never constructs analytics. It only writes raw data.
 *   - Ingestion is idempotent: re-running it upserts, never duplicates.
 */

import type { AccountFundingEntry, TradeHistoryEntry } from '../pacifica/types/account';
import { prisma } from '../../lib/prisma';
import { fillId, mapFillToTrade } from './mapper';

// ─── Result types ─────────────────────────────────────────────────────────────

export interface IngestTradesResult {
  fillsProcessed: number;
  tradesUpserted: number;
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
 * @param fills         Raw fill array from client.account.getAllTradeHistory()
 * @param walletAddress The wallet address these fills belong to
 */
export async function ingestTrades(
  fills: TradeHistoryEntry[],
  walletAddress: string,
): Promise<IngestTradesResult> {
  const result: IngestTradesResult = {
    fillsProcessed: 0,
    tradesUpserted: 0,
    skipped: 0,
    errors: [],
  };

  if (fills.length === 0) return result;
  result.fillsProcessed = fills.length;

  // Map all fills → TradeCreateInput
  const mappedFills = fills.map((f) => mapFillToTrade(f, walletAddress));

  // Upsert Trade records
  for (const trade of mappedFills) {
    try {
      await prisma.trade.upsert({
        where: { id: trade.id },
        create: {
          id: trade.id,
          walletAddress: trade.walletAddress,
          asset: trade.asset,
          direction: trade.direction,
          size: trade.size,
          entryPrice: trade.entryPrice,
          exitPrice: trade.exitPrice ?? null,
          entryTime: trade.entryTime ?? null,
          exitTime: trade.exitTime ?? null,
          pnlRealized: trade.pnlRealized ?? null,
          fees: trade.fees ?? null,
          holdTimeSeconds: trade.holdTimeSeconds ?? null,
          captureMode: trade.captureMode,
          tradeType: trade.tradeType ?? null,
          cause: trade.cause ?? null,
          fundingEarned: null,
          fundingPaid: null,
          rawData: trade.rawData,
          createdAt: trade.createdAt,
          updatedAt: trade.updatedAt,
        },
        update: {
          exitPrice: trade.exitPrice ?? null,
          exitTime: trade.exitTime ?? null,
          entryTime: trade.entryTime ?? null,
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
 */
export async function ingestFunding(
  events: AccountFundingEntry[],
  walletAddress: string,
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

      const matchedTrade = await prisma.trade.findFirst({
        where: {
          walletAddress,
          asset: event.symbol,
          entryTime: { lte: eventTime },
          OR: [
            { exitTime: null },
            { exitTime: { gte: eventTime } },
          ],
        },
        orderBy: { entryTime: 'desc' },
      });

      await prisma.fundingHistory.upsert({
        where: { id: `funding_${event.history_id}` },
        create: {
          id: `funding_${event.history_id}`,
          walletAddress,
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
        if (payout >= 0) {
          await prisma.trade.update({
            where: { id: matchedTrade.id },
            data: { fundingEarned: { increment: payout }, updatedAt: new Date() },
          });
        } else {
          await prisma.trade.update({
            where: { id: matchedTrade.id },
            data: { fundingPaid: { increment: Math.abs(payout) }, updatedAt: new Date() },
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

  return result;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Check which fill IDs are already in the database for a specific wallet.
 * Scoped by walletAddress to prevent cross-wallet fill ID collisions from
 * silently dropping fills during import dedup.
 */
export async function getExistingFillIds(walletAddress: string): Promise<Set<string>> {
  const trades = await prisma.trade.findMany({
    where: { walletAddress, id: { startsWith: 'pacifica_fill_' } },
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
