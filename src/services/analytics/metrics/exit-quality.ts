/**
 * Exit-quality metrics.
 *
 *   exitEfficiency   = actual move captured / maximum favorable move available
 *                      1.0 = perfect exit at the top,
 *                      0.5 = captured half the move,
 *                      0.0 = exited at entry,
 *                      <0  = exited in the red.
 *
 *   moneyLeftOnTable = MFE dollar P&L − actual dollar P&L.
 *
 *   maeRatio         = MAE dollar P&L (absolute) / actual dollar P&L (absolute).
 *                      High values → took a lot of heat for the gain realized.
 *
 * MFE/MAE can be sourced two ways:
 *   1. Already stored on the position (mfePrice / mfePnl / maePnl) — used as-is.
 *   2. Derived from candle priceData passed by the analytics service. In this
 *      case the computer also OUTPUTS mfePrice/mfePnl/maePrice/maePnl so the
 *      analytics service can persist them alongside the efficiency metrics.
 *
 * A position must be closed to produce any output.
 */

import type { MetricComputer, Position } from './base';
import type { Candle } from '../types';

interface CandleDerivedMfeMae {
  mfePrice: number;
  mfePnl: number;
  maePrice: number;
  maePnl: number;
}

/**
 * Compute MFE and MAE prices from a candle slice covering the position's
 * hold period. Returns null if required position fields are missing.
 *
 * For longs:  MFE = highest high (best price you could have exited at)
 *             MAE = lowest low   (worst price the position reached)
 * For shorts: MFE = lowest low   (best price you could have covered at)
 *             MAE = highest high (worst price the position reached)
 */
function deriveFromCandles(position: Position, candles: Candle[]): CandleDerivedMfeMae | null {
  const entry = position.averageEntryPrice;
  const size = position.totalSize;

  if (entry == null || entry === 0 || size == null || size === 0) {
    console.log(`[exit-quality] position ${position.id}: skipping — missing entry (${entry}) or size (${size})`);
    return null;
  }
  if (candles.length === 0) {
    console.log(`[exit-quality] position ${position.id}: skipping — no candles provided`);
    return null;
  }

  const mfePrice = position.direction === 'long'
    ? Math.max(...candles.map((c) => c.high))
    : Math.min(...candles.map((c) => c.low));

  const maePrice = position.direction === 'long'
    ? Math.min(...candles.map((c) => c.low))
    : Math.max(...candles.map((c) => c.high));

  // PnL = price_move_per_unit × total_size
  const mfePnl = position.direction === 'long'
    ? (mfePrice - entry) * size
    : (entry - mfePrice) * size;

  const maePnl = position.direction === 'long'
    ? (maePrice - entry) * size
    : (entry - maePrice) * size;

  console.log(
    `[exit-quality] position ${position.id} (${position.direction} ${position.asset}): ` +
    `entry=${entry} size=${size} ${candles.length} candles → ` +
    `mfePrice=${mfePrice.toFixed(4)} mfePnl=${mfePnl.toFixed(2)} ` +
    `maePrice=${maePrice.toFixed(4)} maePnl=${maePnl.toFixed(2)}`,
  );

  return {
    mfePrice: round(mfePrice, 6),
    mfePnl: round(mfePnl, 2),
    maePrice: round(maePrice, 6),
    maePnl: round(maePnl, 2),
  };
}

export const exitQualityComputer: MetricComputer = {
  name: 'exit-quality',
  requiredFields: [
    'status',
    'direction',
    'averageEntryPrice',
    'averageExitPrice',
    'totalSize',
    // These may be pre-stored or derived from priceData:
    'mfePrice', 'mfePnl', 'maePnl',
    'aggregatePnl',
  ],

  compute(position: Position, priceData?: Candle[]): Record<string, number | string | null> {
    const out: Record<string, number | null> = {
      exitEfficiency: null,
      moneyLeftOnTable: null,
      maeRatio: null,
      // These will be set if we derive them from candles
      mfePrice: null,
      mfePnl: null,
      maePrice: null,
      maePnl: null,
    };

    if (position.status !== 'closed') return out;

    // ── Resolve MFE/MAE source ──────────────────────────────────────────────
    let mfePnl = position.mfePnl;
    let maePnl = position.maePnl;
    let mfePrice = position.mfePrice;

    const hasMfeData = mfePnl != null && mfePrice != null;

    if (!hasMfeData) {
      if (!priceData || priceData.length === 0) {
        // No pre-stored data and no candles — can't compute anything.
        console.log(
          `[exit-quality] position ${position.id}: no MFE data on record and no candles passed — ` +
          `exitEfficiency will remain null. Run analytics after candle data is available.`,
        );
        return out;
      }
      // Derive from candle data
      const derived = deriveFromCandles(position, priceData);
      if (!derived) return out;

      mfePnl    = derived.mfePnl;
      maePnl    = derived.maePnl;
      mfePrice  = derived.mfePrice;

      // Write derived values into the output so the analytics service persists them
      out.mfePrice = derived.mfePrice;
      out.mfePnl   = derived.mfePnl;
      out.maePrice = derived.maePrice;
      out.maePnl   = derived.maePnl;
    }

    // ── Exit efficiency — price-based ──────────────────────────────────────
    const entry = position.averageEntryPrice;
    const exit  = position.averageExitPrice;

    if (
      entry != null && entry > 0 &&
      exit  != null &&
      mfePrice != null && mfePrice !== entry
    ) {
      const actualMove = position.direction === 'long' ? exit - entry : entry - exit;
      const maxMove    = position.direction === 'long' ? mfePrice - entry : entry - mfePrice;
      if (maxMove > 0) {
        out.exitEfficiency = round(actualMove / maxMove, 4);
      }
    }

    // ── Money left on table — dollar-based ────────────────────────────────
    const actualPnl = position.aggregatePnl;
    if (mfePnl != null && actualPnl != null) {
      out.moneyLeftOnTable = round(Math.max(0, mfePnl - actualPnl), 2);
    }

    // ── MAE ratio — how much heat relative to gain ────────────────────────
    if (maePnl != null && actualPnl != null && actualPnl !== 0) {
      out.maeRatio = round(Math.abs(maePnl) / Math.abs(actualPnl), 3);
    }

    // Clear the stored-price pass-throughs if we didn't derive them
    // (don't overwrite non-null DB values with null)
    if (hasMfeData) {
      delete out.mfePrice;
      delete out.mfePnl;
      delete out.maePrice;
      delete out.maePnl;
    }

    return out;
  },
};

function round(value: number, digits: number): number {
  const mult = Math.pow(10, digits);
  return Math.round(value * mult) / mult;
}
