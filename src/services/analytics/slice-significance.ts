/**
 * Slice-vs-complement significance for breakdown tables.
 *
 * Given the P&L values for a breakdown row (the "slice") and for every other
 * row combined (the "complement"), run two hypothesis tests:
 *   - Welch t-test on raw P&L
 *   - Chi-squared (or Fisher exact) on win rate (pnl > 0)
 *
 * Returns the p-values, an `isSignificant` flag that is true when either
 * test rejects at alpha=0.05, and the slice sample size so callers can
 * suppress the badge for tiny buckets.
 *
 * These are individual tests — no multiple-comparison correction is
 * applied. Callers that need FDR control should feed the raw p-values
 * into `benjaminiHochbergPValues` from statistics.ts.
 */

import { welchTTest, chiSquaredProportionTest } from './statistics';

export interface SliceSignificance {
  pnlPValue: number | null;
  winRatePValue: number | null;
  isSignificant: boolean;
  sampleSize: number;
}

const ALPHA = 0.05;

export function computeSliceSignificance(
  slicePnls: number[],
  complementPnls: number[],
): SliceSignificance {
  const sampleSize = slicePnls.length;

  if (slicePnls.length < 2 || complementPnls.length < 2) {
    return { pnlPValue: null, winRatePValue: null, isSignificant: false, sampleSize };
  }

  const pnlTest = welchTTest(slicePnls, complementPnls);

  const sliceWins = slicePnls.reduce((n, p) => n + (p > 0 ? 1 : 0), 0);
  const compWins  = complementPnls.reduce((n, p) => n + (p > 0 ? 1 : 0), 0);
  const winRateTest = chiSquaredProportionTest(
    sliceWins, slicePnls.length,
    compWins,  complementPnls.length,
  );

  // Either test reports 1.0 when it can't run (insufficient data / zero
  // variance / degenerate proportion). Treat those as "null" for the UI
  // so the badge can show "insufficient data" instead of "not significant".
  const pnlPValue     = Number.isFinite(pnlTest.pValue)     ? pnlTest.pValue     : null;
  const winRatePValue = Number.isFinite(winRateTest.pValue) ? winRateTest.pValue : null;

  const isSignificant =
    (pnlPValue     !== null && pnlPValue     < ALPHA) ||
    (winRatePValue !== null && winRatePValue < ALPHA);

  return { pnlPValue, winRatePValue, isSignificant, sampleSize };
}
