'use client';

import type { PerformanceStats } from './types';

/**
 * Shared significance badge for breakdown-table rows.
 *
 * Three display states:
 *   - sampleSize < 10           → "(insufficient data)"
 *   - isSignificant && N ≥ 20   → green "✓ Significant (p=…)"
 *   - otherwise                 → gray "(not significant, N=…)"
 */
export default function SignificanceBadge({
  stats,
}: {
  stats: Pick<PerformanceStats, 'pnlPValue' | 'winRatePValue' | 'isSignificant' | 'sampleSize'>;
}) {
  const n = stats.sampleSize ?? 0;

  if (n < 10) {
    return (
      <span className="text-[11px] text-[#6e7681] whitespace-nowrap">
        (insufficient data)
      </span>
    );
  }

  // Report the smaller of the two p-values so users see the stronger signal.
  const pnlP = stats.pnlPValue ?? null;
  const wrP  = stats.winRatePValue ?? null;
  const best =
    pnlP != null && wrP != null ? Math.min(pnlP, wrP) :
    pnlP != null ? pnlP :
    wrP  != null ? wrP  : null;

  if (stats.isSignificant && n >= 20 && best != null) {
    const pStr = best < 0.001 ? 'p<0.001' : `p=${best.toFixed(3)}`;
    return (
      <span
        className="text-[11px] text-green-400 whitespace-nowrap"
        title="Significant by Welch t-test on P&L or chi-squared on win rate at α=0.05."
      >
        ✓ Significant ({pStr})
      </span>
    );
  }

  return (
    <span className="text-[11px] text-[#6e7681] whitespace-nowrap">
      (not significant, N={n})
    </span>
  );
}

export const SIGNIFICANCE_FOOTNOTE =
  'Significance tested via Welch t-test (P&L) and chi-squared (win rate) at p < 0.05. ' +
  'These are individual tests — see Edge Finder for multiple-comparison corrected results.';
