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
import type { AccountAPI } from '../pacifica/rest/account';
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

// ─── Equity snapshots ingestion ───────────────────────────────────────────────

export interface SyncEquitySnapshotsResult {
  fetched: number;
  upserted: number;
  errors: string[];
}

// Pacifica timestamps come back as Unix epoch — usually milliseconds but
// occasionally seconds depending on endpoint. Magnitude check: ~1.7e12 = ms,
// ~1.7e9 = s. Anything below 1e12 we treat as seconds and rescale.
function toJsDate(ts: number): Date {
  return new Date(ts > 1e12 ? ts : ts * 1000);
}

/**
 * Pull total-equity snapshots from Pacifica's /portfolio endpoint and upsert
 * them into the EquitySnapshot table. The @@unique([walletAddress, timestamp])
 * constraint makes this idempotent — re-running the sync just refreshes the
 * latest tail of snapshots.
 */
export async function syncEquitySnapshots(
  walletAddress: string,
  accountApi: AccountAPI,
): Promise<SyncEquitySnapshotsResult> {
  const result: SyncEquitySnapshotsResult = { fetched: 0, upserted: 0, errors: [] };

  let snapshots;
  try {
    snapshots = await accountApi.getEquityHistory({ account: walletAddress, timeRange: 'all' });
  } catch (err) {
    result.errors.push(`getEquityHistory: ${String(err)}`);
    return result;
  }

  result.fetched = snapshots.length;

  for (const snap of snapshots) {
    const accountEquity = parseFloat(snap.account_equity);
    const pnl = parseFloat(snap.pnl);
    const timestamp = toJsDate(snap.timestamp);

    if (!isFinite(accountEquity) || isNaN(timestamp.getTime())) {
      result.errors.push(`bad snapshot ${JSON.stringify(snap)}`);
      continue;
    }

    try {
      await prisma.equitySnapshot.upsert({
        where: { walletAddress_timestamp: { walletAddress, timestamp } },
        create: {
          walletAddress,
          timestamp,
          accountEquity,
          pnl: isFinite(pnl) ? pnl : null,
          source: 'pacifica',
        },
        update: {
          accountEquity,
          pnl: isFinite(pnl) ? pnl : null,
        },
      });
      result.upserted++;
    } catch (err) {
      result.errors.push(`snapshot ${snap.timestamp}: ${String(err)}`);
    }
  }

  console.log(`[sync] Synced ${result.upserted} equity snapshots for ${walletAddress}`);
  return result;
}

// ─── Balance events ingestion ─────────────────────────────────────────────────

export interface SyncBalanceEventsResult {
  fetched: number;
  upserted: number;
  deposits: number;
  withdrawals: number;
  other: number;
  unknownTypes: string[];
  errors: string[];
}

const KNOWN_EVENT_TYPES = new Set([
  'deposit',
  'withdrawal',
  'trade',
  'funding',
  'liquidation',
  'fee',
  'transfer',
  'transfer_in',
  'transfer_out',
  'subaccount_transfer',
  'rebate',
  'realized_pnl',
]);

function classifyEventType(eventType: string): 'deposit' | 'withdrawal' | 'other' {
  const lower = eventType.toLowerCase();
  if (lower.includes('deposit')) return 'deposit';
  if (lower.includes('withdraw')) return 'withdrawal';
  return 'other';
}

/**
 * Pull the full balance-event log from Pacifica with cursor pagination and
 * upsert each event into the BalanceEvent table. Mirrors the pagination
 * pattern in AccountAPI.getAllTradeHistory(). Idempotent via the
 * @@unique([walletAddress, timestamp, eventType, amount]) constraint.
 */
export async function syncBalanceEvents(
  walletAddress: string,
  accountApi: AccountAPI,
): Promise<SyncBalanceEventsResult> {
  const result: SyncBalanceEventsResult = {
    fetched: 0,
    upserted: 0,
    deposits: 0,
    withdrawals: 0,
    other: 0,
    unknownTypes: [],
    errors: [],
  };

  const unknownSeen = new Set<string>();
  let cursor: string | undefined;

  do {
    let page;
    try {
      page = await accountApi.getBalanceHistory({ account: walletAddress, cursor });
    } catch (err) {
      result.errors.push(`getBalanceHistory cursor=${cursor ?? 'start'}: ${String(err)}`);
      break;
    }

    result.fetched += page.data.length;

    for (const entry of page.data) {
      const amount = parseFloat(entry.amount);
      const balance = parseFloat(entry.balance);
      const timestamp = toJsDate(entry.created_at);
      const eventType = entry.event_type;

      if (!isFinite(amount) || isNaN(timestamp.getTime())) {
        result.errors.push(`bad balance entry ${JSON.stringify(entry)}`);
        continue;
      }

      if (!KNOWN_EVENT_TYPES.has(eventType.toLowerCase()) && !unknownSeen.has(eventType)) {
        unknownSeen.add(eventType);
        console.warn(`[sync] unknown balance event_type "${eventType}" — classifying as 'other'`);
      }

      const bucket = classifyEventType(eventType);
      if (bucket === 'deposit') result.deposits++;
      else if (bucket === 'withdrawal') result.withdrawals++;
      else result.other++;

      try {
        await prisma.balanceEvent.upsert({
          where: {
            walletAddress_timestamp_eventType_amount: {
              walletAddress,
              timestamp,
              eventType,
              amount,
            },
          },
          create: {
            walletAddress,
            timestamp,
            eventType,
            amount,
            balance: isFinite(balance) ? balance : null,
            source: 'pacifica',
          },
          update: {
            balance: isFinite(balance) ? balance : null,
          },
        });
        result.upserted++;
      } catch (err) {
        result.errors.push(`event ${entry.created_at}/${eventType}: ${String(err)}`);
      }
    }

    cursor = page.next_cursor ?? undefined;
    if (!page.has_more) break;
  } while (cursor);

  result.unknownTypes = Array.from(unknownSeen);
  console.log(
    `[sync] Synced ${result.upserted} balance events ` +
      `(${result.deposits} deposits, ${result.withdrawals} withdrawals, ${result.other} other)` +
      (result.unknownTypes.length > 0
        ? ` — unknown event_types: ${result.unknownTypes.join(', ')}`
        : ''),
  );

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
