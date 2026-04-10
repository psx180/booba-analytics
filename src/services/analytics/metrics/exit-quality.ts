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
 * A position must be closed and have MFE/MAE data to produce these metrics.
 */

import type { MetricComputer, Position } from './base';

export const exitQualityComputer: MetricComputer = {
  name: 'exit-quality',
  requiredFields: [
    'status',
    'direction',
    'averageEntryPrice',
    'averageExitPrice',
    'mfePrice',
    'mfePnl',
    'maePnl',
    'aggregatePnl',
  ],

  compute(position: Position): Record<string, number | null> {
    const out: Record<string, number | null> = {
      exitEfficiency: null,
      moneyLeftOnTable: null,
      maeRatio: null,
    };

    if (position.status !== 'closed') return out;

    const entry = position.averageEntryPrice;
    const exit = position.averageExitPrice;
    const mfePrice = position.mfePrice;
    const mfePnl = position.mfePnl;
    const maePnl = position.maePnl;
    const actualPnl = position.aggregatePnl;

    // Exit efficiency — price-based, so that position size doesn't distort it.
    if (
      entry != null && entry > 0 &&
      exit != null &&
      mfePrice != null &&
      mfePrice !== entry
    ) {
      const actualMove = position.direction === 'long' ? exit - entry : entry - exit;
      const maxMove = position.direction === 'long' ? mfePrice - entry : entry - mfePrice;
      if (maxMove > 0) {
        out.exitEfficiency = round(actualMove / maxMove, 4);
      }
    }

    // Money left on table — dollar-based.
    if (mfePnl != null && actualPnl != null) {
      out.moneyLeftOnTable = round(Math.max(0, mfePnl - actualPnl), 2);
    }

    // MAE ratio — how much heat relative to gain.
    if (maePnl != null && actualPnl != null && actualPnl !== 0) {
      out.maeRatio = round(Math.abs(maePnl) / Math.abs(actualPnl), 3);
    }

    return out;
  },
};

function round(value: number, digits: number): number {
  const mult = Math.pow(10, digits);
  return Math.round(value * mult) / mult;
}
