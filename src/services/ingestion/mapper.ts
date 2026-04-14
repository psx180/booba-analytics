/**
 * mapper.ts
 *
 * Converts raw Pacifica API fills into Prisma Trade create inputs.
 * Pure function — no DB, no API calls. Easy to test in isolation.
 *
 * A Pacifica fill has a `side` field that tells us what happened:
 *   open_long  → entered a long position
 *   open_short → entered a short position
 *   close_long → closed a long position (PnL realized here)
 *   close_short → closed a short position (PnL realized here)
 *
 * Each fill also carries `entry_price` (the weighted avg entry of the
 * position being affected), which means close fills are self-contained:
 * we don't need to find the matching open fill to know entry/exit/pnl.
 */

import type { TradeHistoryEntry } from '../pacifica/types/account';

// The shape Prisma expects for a Trade upsert
export interface TradeCreateInput {
  id: string;              // our own ID — we use history_id as stable external key
  walletAddress: string;
  asset: string;
  direction: string;       // 'long' | 'short'
  size: number;
  entryPrice: number;
  exitPrice: number | null;
  entryTime: Date | null;  // null for open fills — resolved during grouping
  exitTime: Date | null;   // set for close fills
  pnlRealized: number | null;
  fees: number | null;
  captureMode: string;     // 'retroactive' | 'live'
  tradeType: string;       // 'directional' | 'liquidation_acquisition' etc.
  cause: string | null;    // raw cause from Pacifica: 'normal' | 'market_liquidation' | 'backstop_liquidation' | 'settlement'
  rawData: string;         // full JSON of the original fill
  fundingEarned: number | null;
  fundingPaid: number | null;
  holdTimeSeconds: number | null;
  // Metadata
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Stable ID for a fill — using the Pacifica history_id so we can safely
 * re-run ingestion without creating duplicates.
 */
export function fillId(fill: TradeHistoryEntry): string {
  return `pacifica_fill_${fill.history_id}`;
}

/**
 * Derive the position direction from the fill's side field.
 * open_long / close_long → 'long'
 * open_short / close_short → 'short'
 */
function directionFromSide(side: string): 'long' | 'short' {
  return side.includes('long') ? 'long' : 'short';
}

function isCloseFill(side: string): boolean {
  return side.startsWith('close_');
}

function causeToTradeType(cause: string): string {
  switch (cause) {
    case 'market_liquidation':
    case 'backstop_liquidation':
      return 'liquidation_acquisition';
    default:
      return 'directional';
  }
}

/**
 * Maps a single Pacifica fill to a TradeCreateInput.
 *
 * Close fills are the "completed trade" records — they carry entry_price,
 * exit price, pnl, and fees. Open fills are placeholders that get merged
 * into trade groups during the grouping step.
 */
export function mapFillToTrade(fill: TradeHistoryEntry, walletAddress: string): TradeCreateInput {
  const isClose = isCloseFill(fill.side);
  const now = new Date();

  return {
    id: fillId(fill),
    walletAddress,
    asset: fill.symbol,
    direction: directionFromSide(fill.side),
    size: parseFloat(fill.amount),

    // entry_price is the avg entry of the position at the time of this fill
    entryPrice: parseFloat(fill.entry_price),

    // Exit price is the fill price for close events; null for open events
    exitPrice: isClose ? parseFloat(fill.price) : null,

    // Open fills don't have a standalone entry time — the grouper resolves this
    // by finding the corresponding open fill
    entryTime: isClose ? null : new Date(fill.created_at),
    exitTime: isClose ? new Date(fill.created_at) : null,

    pnlRealized: isClose ? parseFloat(fill.pnl) : null,
    fees: parseFloat(fill.fee),

    captureMode: 'retroactive',
    tradeType: causeToTradeType(fill.cause),
    cause: fill.cause ?? null,

    fundingEarned: null,
    fundingPaid: null,
    holdTimeSeconds: null,

    // Store the full raw fill so we never lose anything
    rawData: JSON.stringify(fill),

    createdAt: now,
    updatedAt: now,
  };
}
