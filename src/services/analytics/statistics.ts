/**
 * Statistical utilities for insight detectors.
 *
 * Pure functions — no state, no database access. Every insight detector
 * imports from here so significance testing is consistent across modules.
 */

import * as ss from 'simple-statistics';
import type { Insight } from './types';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface StatisticalTest {
  testName: string;         // 'welch_t_test' | 'chi_squared' | 'correlation' | 'proportion_test'
  pValue: number;           // probability the result is due to chance
  effectSize: number;       // Cohen's d for means, phi for proportions, |r| for correlation
  sampleSizeA: number;
  sampleSizeB: number;
  isSignificant: boolean;   // p < alpha (default 0.05)
  correctionApplied?: string;
  description: string;      // human-readable summary
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Welch's t-test for comparing means of two independent groups.
 * Workhorse for behavioral insights (winners vs losers hold time, etc.).
 */
export function welchTTest(groupA: number[], groupB: number[]): StatisticalTest {
  if (groupA.length < 2 || groupB.length < 2) {
    return insufficientData('welch_t_test', groupA.length, groupB.length);
  }

  const meanA = ss.mean(groupA);
  const meanB = ss.mean(groupB);
  const varA  = ss.sampleVariance(groupA);
  const varB  = ss.sampleVariance(groupB);
  const nA    = groupA.length;
  const nB    = groupB.length;

  const se2A = varA / nA;
  const se2B = varB / nB;
  const se   = Math.sqrt(se2A + se2B);

  if (se === 0) return insufficientData('welch_t_test', nA, nB);

  const t  = (meanA - meanB) / se;

  // Welch-Satterthwaite degrees of freedom
  const df = (se2A + se2B) ** 2 / (se2A ** 2 / (nA - 1) + se2B ** 2 / (nB - 1));

  const pValue     = tDistPValue(Math.abs(t), df);
  const d          = cohensD(groupA, groupB);
  const isSignificant = pValue < 0.05;

  return {
    testName: 'welch_t_test',
    pValue,
    effectSize: d,
    sampleSizeA: nA,
    sampleSizeB: nB,
    isSignificant,
    description: describeSignificanceInternal(pValue, nA + nB, d),
  };
}

/**
 * Chi-squared test for comparing two proportions (win rates, etc.).
 */
export function chiSquaredProportionTest(
  successesA: number, totalA: number,
  successesB: number, totalB: number,
): StatisticalTest {
  if (totalA < 5 || totalB < 5) {
    return insufficientData('chi_squared', totalA, totalB);
  }

  const pPooled = (successesA + successesB) / (totalA + totalB);
  if (pPooled === 0 || pPooled === 1) {
    return insufficientData('chi_squared', totalA, totalB);
  }

  const eA1 = pPooled * totalA;
  const eB1 = pPooled * totalB;
  const eA0 = (1 - pPooled) * totalA;
  const eB0 = (1 - pPooled) * totalB;

  const chi2 =
    (successesA - eA1) ** 2 / eA1 +
    (successesB - eB1) ** 2 / eB1 +
    ((totalA - successesA) - eA0) ** 2 / eA0 +
    ((totalB - successesB) - eB0) ** 2 / eB0;

  const pValue = 1 - chiSquaredCDF1(chi2);
  const phi    = Math.sqrt(chi2 / (totalA + totalB));
  const isSignificant = pValue < 0.05;

  return {
    testName: 'chi_squared',
    pValue,
    effectSize: phi,
    sampleSizeA: totalA,
    sampleSizeB: totalB,
    isSignificant,
    description: describeSignificanceInternal(pValue, totalA + totalB, phi),
  };
}

/**
 * Pearson correlation between two paired numeric arrays.
 */
export function pearsonCorrelation(xs: number[], ys: number[]): StatisticalTest {
  const n = Math.min(xs.length, ys.length);
  if (n < 4) return insufficientData('correlation', n, n);

  const r = ss.sampleCorrelation(xs.slice(0, n), ys.slice(0, n));
  const denom = 1 - r * r;

  // Guard against perfect (anti)correlation
  const t = denom < 1e-12 ? Infinity : r * Math.sqrt((n - 2) / denom);
  const pValue = isFinite(t) ? tDistPValue(Math.abs(t), n - 2) : 0;
  const isSignificant = pValue < 0.05;

  return {
    testName: 'correlation',
    pValue,
    effectSize: Math.abs(r),
    sampleSizeA: n,
    sampleSizeB: n,
    isSignificant,
    description: describeSignificanceInternal(pValue, n, Math.abs(r)),
  };
}

/** Cohen's d — effect size for means comparison. */
export function cohensD(groupA: number[], groupB: number[]): number {
  if (groupA.length < 2 || groupB.length < 2) return 0;
  const meanA   = ss.mean(groupA);
  const meanB   = ss.mean(groupB);
  const nA      = groupA.length;
  const nB      = groupB.length;
  const pooledSD = Math.sqrt(
    ((nA - 1) * ss.sampleVariance(groupA) + (nB - 1) * ss.sampleVariance(groupB)) /
    (nA + nB - 2),
  );
  return pooledSD === 0 ? 0 : Math.abs(meanA - meanB) / pooledSD;
}

/**
 * Bonferroni correction for multiple comparisons.
 * Pass all tests from one detector; get back updated isSignificant flags.
 */
export function bonferroniCorrect(
  tests: StatisticalTest[],
  originalAlpha = 0.05,
): StatisticalTest[] {
  if (tests.length === 0) return tests;
  const threshold = originalAlpha / tests.length;
  return tests.map((t) => ({
    ...t,
    isSignificant: t.pValue < threshold,
    correctionApplied: 'bonferroni',
    description: describeSignificanceInternal(t.pValue, t.sampleSizeA + t.sampleSizeB, t.effectSize, threshold),
  }));
}

/** Human-readable significance description from a completed test. */
export function describeSignificance(test: StatisticalTest): string {
  return test.description;
}

/**
 * Standardized impact score for ranking insights across detectors.
 * Formula: abs(dollarImpact) * (1 - pValue) * actionability
 * actionability: 1.0 = directly actionable, 0.7 = behavioral, 0.4 = informational.
 */
export function computeImpactScore(
  dollarImpact: number,
  test: StatisticalTest,
  actionability: number,
): number {
  return Math.abs(dollarImpact) * (1 - test.pValue) * actionability;
}

/**
 * Benjamini-Hochberg FDR correction across all insight detectors.
 *
 * Collects every StatisticalTest from every insight, ranks by p-value, and
 * marks only those that fall below the BH threshold as significant.
 * Updates each parent Insight's isSignificant flag (true only if ALL its
 * backing tests survived) and penalises impactScore for demoted insights.
 *
 * @param fdrRate - False Discovery Rate target (default 0.10)
 */
export function benjaminiHochberg(insights: Insight[], fdrRate = 0.10): Insight[] {
  // Collect all tests with origin indices
  interface TestRef { pValue: number; insightIdx: number; testIdx: number; }
  const allTests: TestRef[] = [];
  insights.forEach((insight, insightIdx) => {
    insight.statistics.forEach((test, testIdx) => {
      allTests.push({ pValue: test.pValue, insightIdx, testIdx });
    });
  });

  const m = allTests.length;
  if (m === 0) return insights;

  // Sort ascending by p-value (rank 1 = most significant)
  const sorted = [...allTests].sort((a, b) => a.pValue - b.pValue);

  // Find the largest rank k where p_k ≤ (k/m) × fdrRate
  let cutoffIndex = -1;
  for (let i = m - 1; i >= 0; i--) {
    if (sorted[i].pValue <= ((i + 1) / m) * fdrRate) {
      cutoffIndex = i;
      break;
    }
  }

  // Deep-copy so we don't mutate the originals
  const updated = insights.map((insight) => ({
    ...insight,
    statistics: insight.statistics.map((test) => ({ ...test })),
  }));

  // Apply BH significance to each test
  for (let i = 0; i < m; i++) {
    const { insightIdx, testIdx } = sorted[i];
    updated[insightIdx].statistics[testIdx] = {
      ...updated[insightIdx].statistics[testIdx],
      isSignificant: i <= cutoffIndex,
      correctionApplied: 'benjamini-hochberg',
    };
  }

  // Update insight-level isSignificant; penalise demoted insights
  for (const insight of updated) {
    const wasSignificant = insight.isSignificant;
    insight.isSignificant =
      insight.statistics.length > 0 && insight.statistics.every((t) => t.isSignificant);
    if (wasSignificant && !insight.isSignificant) {
      insight.impactScore *= 0.1;
    }
  }

  return updated;
}

// ─── Internal helpers ──────────────────────────────────────────────────────

function describeSignificanceInternal(
  pValue: number,
  n: number,
  effectSize: number,
  threshold = 0.05,
): string {
  const pStr = pValue < 0.001 ? 'p<0.001' : `p=${pValue.toFixed(3)}`;
  const effectLabel =
    effectSize < 0.2 ? 'trivial effect' :
    effectSize < 0.5 ? 'small effect'   :
    effectSize < 0.8 ? 'medium effect'  :
                       'large effect';

  if (pValue < threshold * 0.4) {
    return `Statistically significant (${pStr}, N=${n}, ${effectLabel})`;
  } else if (pValue < threshold) {
    return `Marginally significant (${pStr}, N=${n}, ${effectLabel}) — interpret with caution`;
  } else {
    const needMore = n < 30 ? ' — need more trades for reliable results' : '';
    return `Not significant (${pStr}, N=${n})${needMore}`;
  }
}

function insufficientData(
  testName: string,
  nA: number,
  nB: number,
): StatisticalTest {
  return {
    testName,
    pValue: 1,
    effectSize: 0,
    sampleSizeA: nA,
    sampleSizeB: nB,
    isSignificant: false,
    description: `Not significant (insufficient data, N=${nA + nB}) — need more trades for reliable results`,
  };
}

// ─── Distribution functions ────────────────────────────────────────────────
// Lanczos log-gamma, regularized incomplete beta, and t/chi-squared CDFs.
// Ported from Numerical Recipes (Press et al.).

function lgamma(x: number): number {
  // Lanczos approximation (g=7, 9-term)
  const C = [
    0.99999999999980993,   676.5203681218851,   -1259.1392167224028,
    771.32342877765313,   -176.61502916214059,    12.507343278686905,
    -0.13857109526572012,   9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = C[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += C[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Regularized incomplete beta function I_x(a, b) via continued fraction. */
function betaInc(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  // Symmetry flip for numerical stability
  if (x > (a + 1) / (a + b + 2)) return 1 - betaInc(b, a, 1 - x);

  const lbeta = lgamma(a) + lgamma(b) - lgamma(a + b);
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lbeta) / a;

  // Lentz's continued-fraction method
  const MAXIT = 200;
  const EPS   = 3e-7;
  const TINY  = 1e-30;

  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;

  let c = 1;
  let d = 1 - qab * x / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    // Even step
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d; h *= d * c;
    // Odd step
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return front * h;
}

/** Two-tailed p-value for t-statistic with given degrees of freedom. */
function tDistPValue(t: number, df: number): number {
  const x = df / (df + t * t);
  return betaInc(df / 2, 0.5, x); // = 2 * P(T > |t|) via symmetry
}

/** CDF of chi-squared distribution with df=1 using the error function. */
function chiSquaredCDF1(x: number): number {
  if (x <= 0) return 0;
  return erf(Math.sqrt(x / 2));
}

/** Error function (Abramowitz & Stegun 7.1.26, max error 1.5e-7). */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax   = Math.abs(x);
  const t    = 1 / (1 + 0.3275911 * ax);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-ax * ax));
}