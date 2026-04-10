/**
 * Base helpers for insight detectors.
 *
 * Each detector implements InsightDetector. It receives a full position list
 * plus optional aggregation results (so detectors can reuse computed stats
 * without redoing the math). It returns zero or more Insight objects.
 */

import type { InsightDetector, Insight, Position } from '../types';

export type { InsightDetector, Insight, Position };

/**
 * Confidence heuristic based on sample size.
 * 20 samples → 0.5, 50 → 0.75, 100 → 0.87, 200+ → ~0.95.
 * Kept deliberately simple — a proper bootstrap CI can come later.
 */
export function sampleSizeConfidence(n: number): number {
  if (n <= 0) return 0;
  const c = 1 - Math.exp(-n / 70);
  return Math.round(c * 100) / 100;
}

/** Bucket positions by regime, skipping nulls into an 'unknown' bucket. */
export function bucketByRegime(positions: Position[]): Record<string, Position[]> {
  const out: Record<string, Position[]> = {};
  for (const p of positions) {
    const r = p.regimeAtEntry ?? 'unknown';
    (out[r] ??= []).push(p);
  }
  return out;
}

export function formatRegimeLabel(regime: string): string {
  return regime
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}