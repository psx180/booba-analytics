/**
 * Trading discipline insight via Shannon entropy.
 *
 * For each of five decision dimensions (instrument, direction, size quartile,
 * session bucket, regime) compute the Shannon entropy of how the trader's
 * decisions distribute across categories. Normalize by log₂(k) so each
 * dimension lives on a 0-1 scale where 0 = perfectly concentrated and 1 =
 * perfectly uniform/random. The composite discipline score is
 *
 *     average((1 - normalizedEntropy) for each dimension) × 100
 *
 * — higher = more focused / rule-driven.
 *
 * Conditional entropy H(action | outcome) measures whether the trader has
 * consistent rules for responding to wins vs losses. Low = consistent
 * pattern. High = erratic.
 *
 * The detector also produces a 30-trade rolling discipline series so the
 * dashboard can show the trend.
 *
 * Statistical backing: chi-squared independence test between action choice
 * (next-trade direction bucket) and prior outcome (win/loss). Significant ⇒
 * the trader is responding to outcomes rather than acting independently.
 */

import type { InsightDetector, Insight, Position } from './base';
import { sampleSizeConfidence } from './base';
import { chiSquaredProportionTest, computeImpactScore } from '../statistics';

const MIN_POSITIONS = 30;
const ROLLING_WINDOW = 30;

// ─── Output types ──────────────────────────────────────────────────────────

export interface EntropyDimension {
  name: string;
  entropy: number;
  normalizedEntropy: number;
  maxEntropy: number;
}

export interface EntropyResult {
  compositeScore: number;
  dimensions: EntropyDimension[];
  conditionalEntropy: number;
  rollingSeries: { date: string; score: number }[];
  trend: 'improving' | 'declining' | 'stable';
  tradeCount: number;
}

// ─── Public API ────────────────────────────────────────────────────────────

export function computeEntropyResult(positions: Position[]): EntropyResult {
  const sorted = [...positions]
    .filter((p) => p.aggregatePnl != null && p.firstEntryTime != null)
    .sort((a, b) => a.firstEntryTime!.getTime() - b.firstEntryTime!.getTime());

  if (sorted.length === 0) {
    return {
      compositeScore: 0,
      dimensions: [],
      conditionalEntropy: 0,
      rollingSeries: [],
      trend: 'stable',
      tradeCount: 0,
    };
  }

  const dimensions = computeAllDimensions(sorted);
  const compositeScore = round(
    100 * averageDiscipline(dimensions),
    1,
  );

  const conditionalEntropy = computeConditionalEntropy(sorted);

  // Rolling discipline: slide a 30-trade window across the sequence,
  // recompute the composite score for each window's slice.
  const rollingSeries: { date: string; score: number }[] = [];
  for (let i = ROLLING_WINDOW - 1; i < sorted.length; i++) {
    const window = sorted.slice(i - ROLLING_WINDOW + 1, i + 1);
    const dims = computeAllDimensions(window);
    const score = round(100 * averageDiscipline(dims), 1);
    rollingSeries.push({
      date: (sorted[i].lastExitTime ?? sorted[i].firstEntryTime!).toISOString(),
      score,
    });
  }

  return {
    compositeScore,
    dimensions,
    conditionalEntropy: round(conditionalEntropy, 4),
    rollingSeries,
    trend: trendOf(rollingSeries),
    tradeCount: sorted.length,
  };
}

// ─── InsightDetector ───────────────────────────────────────────────────────

export const entropyInsightDetector: InsightDetector = {
  name: 'entropy',
  minimumPositions: MIN_POSITIONS,
  dimensions: ['asset', 'direction', 'totalSize', 'entryHour', 'regimeAtEntry'],

  detect(positions: Position[]): Insight[] {
    const qualified = positions.filter(
      (p) => p.aggregatePnl != null && p.firstEntryTime != null,
    );
    if (qualified.length < MIN_POSITIONS) return [];

    const result = computeEntropyResult(qualified);

    // Statistical backing: chi-squared on whether the next direction depends
    // on the prior trade's win/loss outcome. We bin the chronologically-sorted
    // sequence into long-after-win, long-after-loss, short-after-win, etc.,
    // and compare the long-vs-short proportions across the win/loss split.
    const sorted = [...qualified].sort(
      (a, b) => a.firstEntryTime!.getTime() - b.firstEntryTime!.getTime(),
    );
    const split = directionAfterOutcomeSplit(sorted);
    const test = chiSquaredProportionTest(
      split.afterWinLong, split.afterWinTotal,
      split.afterLossLong, split.afterLossTotal,
    );

    const score = result.compositeScore;
    let title = `Decision Consistency Score: ${score}/100`;
    let severity: Insight['severity'] = 'info';

    const focusedDims = result.dimensions
      .filter((d) => d.normalizedEntropy < 0.5)
      .map((d) => d.name);
    const scatteredDims = result.dimensions
      .filter((d) => d.normalizedEntropy > 0.85)
      .map((d) => d.name);

    let body: string;
    if (score >= 65) {
      body =
        `Your trading discipline score is ${score}/100 based on Shannon entropy ` +
        `analysis of your decisions. You trade with focus — concentrated on ` +
        `${focusedDims.length > 0 ? focusedDims.join(', ') : 'specific dimensions'}, ` +
        `consistent sizing, and predictable timing. This suggests systematic, ` +
        `rule-based trading.`;
    } else if (score >= 40) {
      body =
        `Your trading discipline score is ${score}/100. You show focus on some ` +
        `dimensions but not others. ` +
        (scatteredDims.length > 0
          ? `Scattered across ${scatteredDims.join(', ')}.`
          : '');
    } else {
      body =
        `Your trading discipline score is ${score}/100. Your trading is ` +
        `scattered ${scatteredDims.length > 0 ? `across ${scatteredDims.join(', ')}` : 'across many dimensions'}, ` +
        `with variable sizing and inconsistent timing. This may indicate ` +
        `exploratory trading or lack of a defined system.`;
      severity = 'info';
    }

    if (result.conditionalEntropy > 0.7) {
      body +=
        ` Your response to wins and losses varies significantly ` +
        `(H(action|outcome)=${result.conditionalEntropy.toFixed(2)}) — you don't ` +
        `have consistent rules for how to react to outcomes.`;
    }

    body += ` Your discipline has ${result.trend} over the last ${ROLLING_WINDOW} trades.`;

    return [{
      module: 'entropy',
      title,
      description: body,
      severity,
      confidence: sampleSizeConfidence(result.tradeCount),
      affectedPositions: qualified.map((p) => p.id),
      data: {
        compositeScore: result.compositeScore,
        conditionalEntropy: result.conditionalEntropy,
        trend: result.trend,
        dimensions: result.dimensions,
        tradeCount: result.tradeCount,
      },
      statistics: [test],
      impactScore: computeImpactScore(score, test, 0.4),
      category: 'behavior',
      isSignificant: test.isSignificant,
      sampleSize: result.tradeCount,
    }];
  },
};

// ─── Dimension extraction ──────────────────────────────────────────────────

function computeAllDimensions(positions: Position[]): EntropyDimension[] {
  // Size quartile bins from this slice's distribution. Quartiles computed
  // from the full passed-in sample so a rolling window's quartiles reflect
  // the local size landscape.
  const sizes = positions
    .map((p) => p.totalSize ?? 0)
    .filter((s) => s > 0)
    .sort((a, b) => a - b);
  const quartileBoundaries = sizes.length > 0
    ? [
        sizes[Math.floor(sizes.length * 0.25)],
        sizes[Math.floor(sizes.length * 0.5)],
        sizes[Math.floor(sizes.length * 0.75)],
      ]
    : [0, 0, 0];

  const instrumentCounts = new Map<string, number>();
  const directionCounts  = new Map<string, number>();
  const sizeBucketCounts = new Map<string, number>();
  const sessionCounts    = new Map<string, number>();
  const regimeCounts     = new Map<string, number>();

  for (const p of positions) {
    bump(instrumentCounts, p.asset ?? 'unknown');
    bump(directionCounts, p.direction ?? 'unknown');
    bump(sizeBucketCounts, sizeBucket(p.totalSize ?? 0, quartileBoundaries));
    bump(sessionCounts, sessionFromHour(p.entryHour ?? p.firstEntryTime?.getUTCHours() ?? 0));
    bump(regimeCounts, p.regimeAtEntry ?? 'unknown');
  }

  return [
    dimensionFromCounts('instrument', instrumentCounts),
    dimensionFromCounts('direction',  directionCounts),
    dimensionFromCounts('size',       sizeBucketCounts),
    dimensionFromCounts('session',    sessionCounts),
    dimensionFromCounts('regime',     regimeCounts),
  ];
}

function dimensionFromCounts(name: string, counts: Map<string, number>): EntropyDimension {
  const total = Array.from(counts.values()).reduce((s, v) => s + v, 0);
  if (total === 0) {
    return { name, entropy: 0, normalizedEntropy: 0, maxEntropy: 0 };
  }
  let h = 0;
  for (const c of counts.values()) {
    if (c === 0) continue;
    const p = c / total;
    h -= p * Math.log2(p);
  }
  const k = counts.size;
  const maxH = k > 1 ? Math.log2(k) : 0;
  const normalized = maxH > 0 ? h / maxH : 0;
  return {
    name,
    entropy: round(h, 4),
    normalizedEntropy: round(normalized, 4),
    maxEntropy: round(maxH, 4),
  };
}

function averageDiscipline(dimensions: EntropyDimension[]): number {
  if (dimensions.length === 0) return 0;
  let sum = 0;
  let count = 0;
  for (const d of dimensions) {
    if (d.maxEntropy === 0) continue;
    sum += 1 - d.normalizedEntropy;
    count++;
  }
  return count > 0 ? sum / count : 0;
}

// ─── Conditional entropy ───────────────────────────────────────────────────

/**
 * H(action | outcome) — entropy of the next-trade direction conditioned on
 * the prior trade's win/loss outcome. Returns the standard conditional entropy
 *
 *   H(A|O) = Σ_o p(o) * H(A | O=o)
 *
 * normalized by log2(k_action) so it lives in 0-1.
 */
function computeConditionalEntropy(sorted: Position[]): number {
  if (sorted.length < 2) return 0;

  const buckets = new Map<string, Map<string, number>>(); // outcome → action counts
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur  = sorted[i];
    const outcome = (prev.aggregatePnl ?? 0) > 0 ? 'win' : 'loss';
    const action  = cur.direction ?? 'unknown';
    if (!buckets.has(outcome)) buckets.set(outcome, new Map());
    bump(buckets.get(outcome)!, action);
  }

  const totalAll = sorted.length - 1;
  let h = 0;
  let kAction = 0;
  const allActions = new Set<string>();

  for (const counts of buckets.values()) {
    for (const k of counts.keys()) allActions.add(k);
  }
  kAction = Math.max(allActions.size, 1);

  for (const counts of buckets.values()) {
    const subTotal = Array.from(counts.values()).reduce((s, v) => s + v, 0);
    if (subTotal === 0) continue;
    let hSub = 0;
    for (const c of counts.values()) {
      if (c === 0) continue;
      const p = c / subTotal;
      hSub -= p * Math.log2(p);
    }
    h += (subTotal / totalAll) * hSub;
  }

  const maxH = kAction > 1 ? Math.log2(kAction) : 0;
  return maxH > 0 ? h / maxH : 0;
}

function directionAfterOutcomeSplit(sorted: Position[]): {
  afterWinLong: number;  afterWinTotal: number;
  afterLossLong: number; afterLossTotal: number;
} {
  let afterWinLong = 0, afterWinTotal = 0;
  let afterLossLong = 0, afterLossTotal = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur  = sorted[i];
    const isLong = cur.direction === 'long';
    if ((prev.aggregatePnl ?? 0) > 0) {
      afterWinTotal++;
      if (isLong) afterWinLong++;
    } else if ((prev.aggregatePnl ?? 0) < 0) {
      afterLossTotal++;
      if (isLong) afterLossLong++;
    }
  }
  return { afterWinLong, afterWinTotal, afterLossLong, afterLossTotal };
}

// ─── Utility helpers ───────────────────────────────────────────────────────

function bump(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function sizeBucket(size: number, boundaries: number[]): string {
  if (size === 0) return 'q0';
  if (size <= boundaries[0]) return 'q1';
  if (size <= boundaries[1]) return 'q2';
  if (size <= boundaries[2]) return 'q3';
  return 'q4';
}

function sessionFromHour(hour: number): string {
  if (hour < 6) return 'asian';
  if (hour < 12) return 'european';
  if (hour < 20) return 'us';
  return 'late';
}

function trendOf(series: { date: string; score: number }[]): 'improving' | 'declining' | 'stable' {
  if (series.length < 4) return 'stable';
  const tail = series.slice(-Math.min(20, series.length));
  const m = tail.length;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < m; i++) {
    sx += i;
    sy += tail[i].score;
    sxy += i * tail[i].score;
    sxx += i * i;
  }
  const denom = m * sxx - sx * sx;
  if (Math.abs(denom) < 1e-9) return 'stable';
  const slope = (m * sxy - sx * sy) / denom;
  if (slope > 0.25) return 'improving';
  if (slope < -0.25) return 'declining';
  return 'stable';
}

function round(value: number, digits: number): number {
  const m = Math.pow(10, digits);
  return Math.round(value * m) / m;
}
