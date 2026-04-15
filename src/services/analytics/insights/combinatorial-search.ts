/**
 * Combinatorial significance search — automated edge finder.
 *
 * Unlike the hypothesis-driven detectors (disposition, revenge trading, …)
 * this module exhaustively slices the trader's positions across every
 * meaningful combination of dimensions and surfaces only the slices that
 * survive a Benjamini-Hochberg FDR correction at q = 0.10.
 *
 * Methodology:
 *   1. Build single-dimension slices (regime, asset, session, …).
 *   2. Build two-dimension cross-tabulations.
 *   3. Build three-dimension cross-tabulations (only if ≥100 positions).
 *   4. For every slice with ≥10 positions, run two tests vs. the
 *      complement-within-population: Welch's t-test on P&L and a chi-squared
 *      proportion test on win rate.
 *   5. Apply BH FDR correction across all collected p-values. A slice is
 *      "surviving" if at least one of its two tests survives.
 *   6. Deduplicate nested slices: drop a more-specific finding if its effect
 *      size is within 20% of a less-specific subset finding (it adds nothing).
 *   7. Rank surviving findings by impact = |totalPnl| × (1 − min(p)).
 *
 * The resulting insight is then passed through the cross-detector BH pass in
 * analytics-service.ts. Two levels of correction — within the search and
 * across all detectors — is the established Harvey/Liu/Zhu (2016) approach.
 */

import type { InsightDetector, Insight, Position } from './base';
import { sampleSizeConfidence } from './base';
import type { StatisticalTest } from '../types';
import {
  welchTTest,
  chiSquaredProportionTest,
  computeImpactScore,
  benjaminiHochbergPValues,
} from '../statistics';

const MIN_POSITIONS  = 50;
const MIN_GROUP_SIZE = 25;
const MIN_FOR_3D     = 500;
const FDR_RATE       = 0.10;
const DEDUP_EPSILON  = 0.20;  // child within 20% of parent → drop child

// ─── Dimensions ────────────────────────────────────────────────────────────

interface DimensionDef {
  name: string;
  accessor: (p: Position) => string | null;
}

const DIMENSIONS: DimensionDef[] = [
  { name: 'regime',           accessor: (p) => p.regimeAtEntry },
  { name: 'asset',            accessor: (p) => p.asset },
  { name: 'tradeType',        accessor: (p) => p.tradeType },
  { name: 'entrySession',     accessor: (p) => p.entrySession },
  { name: 'holdTimeCategory', accessor: (p) => p.holdTimeCategory },
  { name: 'direction',        accessor: (p) => p.direction },
];

// ─── Public types ──────────────────────────────────────────────────────────

export interface CombinatorialFinding {
  dimensions: { name: string; value: string }[];
  sliceLabel: string;
  positionCount: number;
  winRate: number;
  avgPnl: number;
  totalPnl: number;
  overallWinRate: number;
  overallAvgPnl: number;
  pnlTest: StatisticalTest;
  winRateTest: StatisticalTest;
  effectDirection: 'better' | 'worse';
}

export interface CombinatorialSearchResult {
  totalTestsRun: number;
  totalSurvivingBH: number;
  fdrRate: number;
  findings: CombinatorialFinding[];     // sorted by impact, BH-survivors only
  topEdges: CombinatorialFinding[];     // top 3 'better' findings
  topWeaknesses: CombinatorialFinding[]; // top 3 'worse' findings
  estimatedSavings: number;             // sum over top 3 weaknesses
  computeMs: number;
}

// ─── Detector ──────────────────────────────────────────────────────────────

export const combinatorialSearchDetector: InsightDetector = {
  name: 'combinatorial-search',
  minimumPositions: MIN_POSITIONS,
  dimensions: DIMENSIONS.map((d) => d.name),

  detect(positions: Position[]): Insight[] {
    const t0 = Date.now();

    const qualified = positions.filter((p) => p.aggregatePnl != null);
    if (qualified.length < MIN_POSITIONS) return [];

    const overallAvgPnl  = qualified.reduce((s, p) => s + (p.aggregatePnl ?? 0), 0) / qualified.length;
    const overallWinners = qualified.filter((p) => (p.aggregatePnl ?? 0) > 0).length;
    const overallWinRate = overallWinners / qualified.length;

    // ─── Generate candidate findings ────────────────────────────────────
    const candidates: CombinatorialFinding[] = [];

    // 1-dim
    for (const dim of DIMENSIONS) {
      candidates.push(
        ...searchCombination([dim], qualified, overallAvgPnl, overallWinRate),
      );
    }

    // 2-dim
    for (const pair of combinations(DIMENSIONS, 2)) {
      candidates.push(
        ...searchCombination(pair, qualified, overallAvgPnl, overallWinRate),
      );
    }

    // 3-dim — only with enough data
    if (qualified.length >= MIN_FOR_3D) {
      for (const triple of combinations(DIMENSIONS, 3)) {
        candidates.push(
          ...searchCombination(triple, qualified, overallAvgPnl, overallWinRate),
        );
      }
    }

    const totalTestsRun = candidates.length * 2; // pnl test + win-rate test per candidate

    // ─── Internal BH correction across ALL p-values ────────────────────
    // Each candidate contributes two p-values; a candidate is "surviving"
    // if at least one of its two tests survives BH at FDR=0.10.
    const flatPValues: number[] = [];
    for (const c of candidates) {
      flatPValues.push(c.pnlTest.pValue);
      flatPValues.push(c.winRateTest.pValue);
    }
    const survivors = benjaminiHochbergPValues(flatPValues, FDR_RATE);

    const surviving: CombinatorialFinding[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const pnlSurvives     = survivors[2 * i];
      const winRateSurvives = survivors[2 * i + 1];
      if (pnlSurvives || winRateSurvives) {
        // Mark which underlying tests passed correction so the frontend can
        // render appropriate badges.
        candidates[i].pnlTest = {
          ...candidates[i].pnlTest,
          isSignificant: pnlSurvives,
          correctionApplied: 'benjamini-hochberg',
        };
        candidates[i].winRateTest = {
          ...candidates[i].winRateTest,
          isSignificant: winRateSurvives,
          correctionApplied: 'benjamini-hochberg',
        };
        surviving.push(candidates[i]);
      }
    }

    // ─── Deduplicate nested findings ───────────────────────────────────
    const deduped = deduplicate(surviving);

    // ─── Rank by impact ────────────────────────────────────────────────
    deduped.sort((a, b) => impactOf(b) - impactOf(a));

    const edges      = deduped.filter((f) => f.effectDirection === 'better');
    const weaknesses = deduped.filter((f) => f.effectDirection === 'worse');
    const topEdges      = edges.slice(0, 3);
    const topWeaknesses = weaknesses.slice(0, 3);

    // Savings model: replacing each weakness slice's trades with average
    // performance recovers (overall − slice) × n dollars per slice.
    const estimatedSavings = topWeaknesses.reduce(
      (sum, w) => sum + Math.max(0, (overallAvgPnl - w.avgPnl) * w.positionCount),
      0,
    );

    const computeMs = Date.now() - t0;

    const result: CombinatorialSearchResult = {
      totalTestsRun,
      totalSurvivingBH: deduped.length,
      fdrRate: FDR_RATE,
      findings: deduped,
      topEdges,
      topWeaknesses,
      estimatedSavings,
      computeMs,
    };

    console.log(
      `[combinatorial-search] ran ${totalTestsRun} tests over ${candidates.length} ` +
      `slices in ${computeMs}ms — ${deduped.length} survived BH at q=${FDR_RATE} ` +
      `(${edges.length} edges, ${weaknesses.length} weaknesses)`,
    );

    // ─── Build the insight card ────────────────────────────────────────
    const N = deduped.length;
    const M = totalTestsRun;

    let title: string;
    let description: string;
    let suggestion: string | undefined;
    let severity: Insight['severity'];

    if (N === 0) {
      title = 'Edge Finder: No Significant Patterns Found';
      description =
        `Tested ${M} dimension combinations — no statistically significant patterns ` +
        `found after multiple-comparison correction. Your performance is consistent ` +
        `across all dimensions tested. This itself is useful information: your edge ` +
        `(or lack thereof) is not concentrated in any particular condition.`;
      severity = 'info';
    } else {
      title = `Edge Finder: ${N} Significant Pattern${N === 1 ? '' : 's'} in ${M} Tests`;
      description = buildDescription(M, N, topEdges[0], topWeaknesses[0], estimatedSavings);
      severity = topWeaknesses.length > 0 ? 'warning' : 'info';
      if (topWeaknesses.length > 0) {
        suggestion =
          `Eliminating your top ${topWeaknesses.length} weakness${topWeaknesses.length === 1 ? '' : 'es'} ` +
          `would improve your total P&L by approximately $${Math.round(estimatedSavings).toLocaleString()}. ` +
          `Review the Edge Finder section to see which slices to avoid.`;
      }
    }

    // Strongest surviving test (lowest p-value across all surviving findings)
    // becomes the insight's backing statistic for the cross-detector BH pass.
    const strongestTest = pickStrongestTest(deduped);
    const statistics: StatisticalTest[] = strongestTest ? [strongestTest] : [
      // No surviving findings — record a non-significant placeholder so the
      // cross-detector pass has something to operate on.
      {
        testName: 'combinatorial_search',
        pValue: 1,
        effectSize: 0,
        sampleSizeA: qualified.length,
        sampleSizeB: 0,
        isSignificant: false,
        description: `No slices survived BH at FDR=${FDR_RATE} across ${M} tests`,
      },
    ];

    // Insight-level impact score: sum of |excess P&L| across all surviving
    // findings, where excess = (slice avg − overall avg) × n. This represents
    // the total dollar magnitude attributable to the discovered patterns.
    const dollarMagnitude = deduped.reduce(
      (s, f) => s + Math.abs((f.avgPnl - overallAvgPnl) * f.positionCount),
      0,
    );
    const impactScore = strongestTest
      ? computeImpactScore(dollarMagnitude, strongestTest, 0.7)
      : 0;

    return [{
      module: 'combinatorial-search',
      title,
      description,
      suggestion,
      severity,
      confidence: sampleSizeConfidence(qualified.length),
      affectedPositions: [],
      data: { combinatorial: result },
      statistics,
      impactScore,
      category: 'strategy',
      isSignificant: strongestTest?.isSignificant ?? false,
      sampleSize: qualified.length,
    }];
  },
};

// ─── Search core ───────────────────────────────────────────────────────────

/**
 * Group qualified positions by the cross-product of the given dimensions and
 * test every group with ≥MIN_GROUP_SIZE positions against its complement.
 */
function searchCombination(
  dims: DimensionDef[],
  qualified: Position[],
  overallAvgPnl: number,
  overallWinRate: number,
): CombinatorialFinding[] {
  // Restrict to positions where every active dimension has a non-null value
  // — otherwise the slice and its complement would be drawn from different
  // populations and the test would be biased.
  const localPositions: Position[] = [];
  const localKeys: string[] = [];
  const localValues: string[][] = [];

  for (const p of qualified) {
    const parts: string[] = [];
    let valid = true;
    for (const d of dims) {
      const v = d.accessor(p);
      if (v == null || v === '') { valid = false; break; }
      parts.push(v);
    }
    if (!valid) continue;
    localPositions.push(p);
    localKeys.push(parts.join('\u0001'));
    localValues.push(parts);
  }

  // Group by composite key
  const groups = new Map<string, { positions: Position[]; values: string[] }>();
  for (let i = 0; i < localPositions.length; i++) {
    const key = localKeys[i];
    const existing = groups.get(key);
    if (existing) {
      existing.positions.push(localPositions[i]);
    } else {
      groups.set(key, { positions: [localPositions[i]], values: localValues[i] });
    }
  }

  if (groups.size < 2) return []; // No meaningful comparison

  const findings: CombinatorialFinding[] = [];

  for (const [, group] of groups) {
    if (group.positions.length < MIN_GROUP_SIZE) continue;

    // Complement = same dimension-qualified population minus this group
    const sliceSet = new Set(group.positions);
    const complement = localPositions.filter((p) => !sliceSet.has(p));
    if (complement.length < MIN_GROUP_SIZE) continue;

    const finding = testSlice(
      group.positions,
      complement,
      dims.map((d, i) => ({ name: d.name, value: group.values[i] })),
      overallAvgPnl,
      overallWinRate,
    );
    if (finding) findings.push(finding);
  }

  return findings;
}

function testSlice(
  slice: Position[],
  complement: Position[],
  dimValues: { name: string; value: string }[],
  overallAvgPnl: number,
  overallWinRate: number,
): CombinatorialFinding | null {
  const slicePnls      = slice.map((p) => p.aggregatePnl ?? 0);
  const complementPnls = complement.map((p) => p.aggregatePnl ?? 0);

  const sliceWinners      = slice.filter((p) => (p.aggregatePnl ?? 0) > 0).length;
  const complementWinners = complement.filter((p) => (p.aggregatePnl ?? 0) > 0).length;

  const pnlTest = welchTTest(slicePnls, complementPnls);
  const winRateTest = chiSquaredProportionTest(
    sliceWinners, slice.length,
    complementWinners, complement.length,
  );

  const sliceTotal = slicePnls.reduce((a, b) => a + b, 0);
  const sliceAvg   = sliceTotal / slice.length;
  const sliceWR    = sliceWinners / slice.length;

  return {
    dimensions: dimValues,
    sliceLabel: dimValues.map((d) => formatDimensionValue(d.name, d.value)).join(' + '),
    positionCount: slice.length,
    winRate: sliceWR,
    avgPnl: sliceAvg,
    totalPnl: sliceTotal,
    overallWinRate,
    overallAvgPnl,
    pnlTest,
    winRateTest,
    effectDirection: sliceAvg > overallAvgPnl ? 'better' : 'worse',
  };
}

// ─── Deduplication ─────────────────────────────────────────────────────────

/**
 * Drop a more-specific finding if a less-specific subset finding has a
 * comparable effect size — the specific version adds no information.
 *
 * Effect-size signal used: max(|pnlTest.effectSize|, |winRateTest.effectSize|).
 * Two findings are "comparable" if |child − parent| / parent ≤ DEDUP_EPSILON.
 */
function deduplicate(findings: CombinatorialFinding[]): CombinatorialFinding[] {
  const dropped = new Set<number>();

  for (let i = 0; i < findings.length; i++) {
    const child = findings[i];
    if (child.dimensions.length < 2) continue;

    for (let j = 0; j < findings.length; j++) {
      if (i === j || dropped.has(j)) continue;
      const parent = findings[j];
      if (parent.dimensions.length >= child.dimensions.length) continue;
      if (!isSubset(parent, child)) continue;

      const childEffect  = effectSizeOf(child);
      const parentEffect = effectSizeOf(parent);
      if (parentEffect === 0) continue;

      const ratio = Math.abs(childEffect - parentEffect) / parentEffect;
      if (ratio <= DEDUP_EPSILON) {
        dropped.add(i);
        break;
      }
    }
  }

  return findings.filter((_, i) => !dropped.has(i));
}

function isSubset(parent: CombinatorialFinding, child: CombinatorialFinding): boolean {
  return parent.dimensions.every((pd) =>
    child.dimensions.some((cd) => cd.name === pd.name && cd.value === pd.value),
  );
}

function effectSizeOf(f: CombinatorialFinding): number {
  return Math.max(Math.abs(f.pnlTest.effectSize), Math.abs(f.winRateTest.effectSize));
}

// ─── Ranking ───────────────────────────────────────────────────────────────

function impactOf(f: CombinatorialFinding): number {
  const minP = Math.min(f.pnlTest.pValue, f.winRateTest.pValue);
  return Math.abs(f.totalPnl) * (1 - minP);
}

function pickStrongestTest(findings: CombinatorialFinding[]): StatisticalTest | null {
  let best: StatisticalTest | null = null;
  for (const f of findings) {
    for (const t of [f.pnlTest, f.winRateTest]) {
      if (!t.isSignificant) continue;
      if (!best || t.pValue < best.pValue) best = t;
    }
  }
  return best;
}

// ─── Description copy ──────────────────────────────────────────────────────

function buildDescription(
  testCount: number,
  findingCount: number,
  topEdge: CombinatorialFinding | undefined,
  topWeakness: CombinatorialFinding | undefined,
  estimatedSavings: number,
): string {
  const parts: string[] = [
    `Systematically tested ${testCount} dimension combinations with Benjamini-Hochberg FDR ` +
    `correction at 10%. Found ${findingCount} statistically significant pattern${findingCount === 1 ? '' : 's'}.`,
  ];

  if (topEdge) {
    parts.push(
      `Your strongest edge: ${topEdge.sliceLabel} — ${(topEdge.winRate * 100).toFixed(0)}% ` +
      `win rate, avg $${topEdge.avgPnl.toFixed(2)} per trade ` +
      `(${describeDelta(topEdge)} vs baseline).`,
    );
  } else {
    parts.push('No statistically significant edges detected.');
  }

  if (topWeakness) {
    parts.push(
      `Your biggest weakness: ${topWeakness.sliceLabel} — ${(topWeakness.winRate * 100).toFixed(0)}% ` +
      `win rate, avg $${topWeakness.avgPnl.toFixed(2)} per trade.`,
    );
    if (estimatedSavings > 0) {
      parts.push(
        `Eliminating ${topWeakness.sliceLabel} trades would improve your total P&L by ` +
        `approximately $${Math.round(
          Math.max(0, (topWeakness.overallAvgPnl - topWeakness.avgPnl) * topWeakness.positionCount),
        ).toLocaleString()}.`,
      );
    }
  } else {
    parts.push('No statistically significant weaknesses detected.');
  }

  return parts.join(' ');
}

function describeDelta(f: CombinatorialFinding): string {
  const delta = f.avgPnl - f.overallAvgPnl;
  const sign  = delta >= 0 ? '+' : '−';
  return `${sign}$${Math.abs(delta).toFixed(2)}`;
}

// ─── Combinations helper ───────────────────────────────────────────────────

function combinations<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (k > arr.length) return [];
  const out: T[][] = [];
  const buf: T[] = new Array(k);

  function recur(start: number, depth: number): void {
    if (depth === k) { out.push([...buf]); return; }
    for (let i = start; i <= arr.length - (k - depth); i++) {
      buf[depth] = arr[i];
      recur(i + 1, depth + 1);
    }
  }
  recur(0, 0);
  return out;
}

// ─── Display formatting ────────────────────────────────────────────────────

const DOW_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const SESSION_LABELS: Record<string, string> = {
  asian:    'Asian Session',
  european: 'European Session',
  us:       'US Session',
};

function formatDimensionValue(name: string, value: string): string {
  switch (name) {
    case 'entryDayOfWeek': {
      const idx = parseInt(value, 10);
      return Number.isFinite(idx) && idx >= 0 && idx < 7 ? DOW_LABELS[idx] : value;
    }
    case 'entrySession':
      return SESSION_LABELS[value] ?? capitalize(value);
    case 'regime':
    case 'tradeType':
    case 'holdTimeCategory':
      return value.split('_').map(capitalize).join(' ');
    case 'direction':
      return capitalize(value);
    case 'asset':
      return value;
    default:
      return value;
  }
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}
