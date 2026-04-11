/**
 * Markov transition analysis for trade outcome sequences.
 *
 * Tests whether trade outcomes are independent draws or whether they
 * exhibit serial dependence. If wins cluster after wins (or losses follow
 * losses) more than chance allows, that's evidence of behavioral regime
 * shifts — overconfidence after wins, tilt after losses.
 *
 * The 2-state model (W / L) is the primary output. If tilt data is
 * available we also build a 3-state model that splits losses into normal
 * and tilt-flagged losses, revealing whether tilt-driven losses have
 * different transition dynamics.
 */

import type { Position } from '../types';
import { chiSquaredProportionTest } from '../statistics';
import type { StatisticalTest } from '../types';

// ─── Output types ──────────────────────────────────────────────────────────

export interface TransitionMatrix {
  WW: number;
  WL: number;
  LW: number;
  LL: number;
}

export interface TransitionProbabilities {
  winAfterWin: number;
  lossAfterWin: number;
  winAfterLoss: number;
  lossAfterLoss: number;
}

export interface MarkovResult {
  transitionMatrix: TransitionMatrix;
  transitionProbabilities: TransitionProbabilities;
  independenceTest: StatisticalTest;
  autocorrelation: number;
  interpretation: string;
  /** Optional 3-state extension W / L / L_tilted (if tilt data present). */
  threeState?: ThreeStateResult;
  /** Sample size used (number of transitions = positions - 1). */
  transitionCount: number;
  overallWinRate: number;
}

export interface ThreeStateResult {
  states: ['W', 'L', 'L_tilted'];
  transitionMatrix: number[][]; // 3x3 counts
  transitionProbabilities: number[][]; // 3x3 probabilities
}

// ─── Public entry point ────────────────────────────────────────────────────

export function runMarkovAnalysis(positions: Position[]): MarkovResult | null {
  // Sort chronologically
  const sorted = [...positions]
    .filter((p) => p.aggregatePnl != null && p.firstEntryTime != null)
    .sort((a, b) => {
      const ta = a.firstEntryTime?.getTime() ?? 0;
      const tb = b.firstEntryTime?.getTime() ?? 0;
      return ta - tb;
    });

  if (sorted.length < 10) return null;

  // Outcome sequence
  const outcomes: ('W' | 'L')[] = sorted.map((p) =>
    (p.aggregatePnl ?? 0) > 0 ? 'W' : 'L',
  );

  // 2x2 transition counts
  const matrix: TransitionMatrix = { WW: 0, WL: 0, LW: 0, LL: 0 };
  for (let i = 1; i < outcomes.length; i++) {
    const from = outcomes[i - 1];
    const to   = outcomes[i];
    if (from === 'W' && to === 'W') matrix.WW++;
    else if (from === 'W' && to === 'L') matrix.WL++;
    else if (from === 'L' && to === 'W') matrix.LW++;
    else matrix.LL++;
  }

  const totalAfterWin  = matrix.WW + matrix.WL;
  const totalAfterLoss = matrix.LW + matrix.LL;

  const probs: TransitionProbabilities = {
    winAfterWin:   totalAfterWin  > 0 ? matrix.WW / totalAfterWin  : 0,
    lossAfterWin:  totalAfterWin  > 0 ? matrix.WL / totalAfterWin  : 0,
    winAfterLoss:  totalAfterLoss > 0 ? matrix.LW / totalAfterLoss : 0,
    lossAfterLoss: totalAfterLoss > 0 ? matrix.LL / totalAfterLoss : 0,
  };

  // Independence test: P(W|W) vs P(W|L). If equal → outcomes independent.
  // Use chi-squared on the two proportions (winAfterWin and winAfterLoss).
  const test = chiSquaredProportionTest(
    matrix.WW, totalAfterWin,
    matrix.LW, totalAfterLoss,
  );

  // Autocorrelation of {0,1} outcome sequence at lag 1
  const numeric: number[] = outcomes.map((o) => (o === 'W' ? 1 : 0));
  const autocorr = lag1Autocorrelation(numeric);

  // Optional 3-state extension
  const threeState = buildThreeState(sorted, outcomes);

  const overallWinRate = numeric.reduce((a, b) => a + b, 0) / numeric.length;

  const interpretation = buildInterpretation(probs, test, overallWinRate);

  return {
    transitionMatrix: matrix,
    transitionProbabilities: roundProbs(probs),
    independenceTest: test,
    autocorrelation: Math.round(autocorr * 1000) / 1000,
    interpretation,
    threeState,
    transitionCount: outcomes.length - 1,
    overallWinRate: Math.round(overallWinRate * 1000) / 1000,
  };
}

// ─── 3-state (with tilt) ──────────────────────────────────────────────────

function buildThreeState(
  sorted: Position[],
  outcomes: ('W' | 'L')[],
): ThreeStateResult | undefined {
  const hasTilt = sorted.some((p) => p.tiltScore != null && p.tiltScore > 0);
  if (!hasTilt) return undefined;

  // Threshold: tiltScore >= 0.5 considered a tilt episode
  const states: (0 | 1 | 2)[] = sorted.map((p, i) => {
    if (outcomes[i] === 'W') return 0;
    if ((p.tiltScore ?? 0) >= 0.5) return 2;
    return 1;
  });

  const counts: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 1; i < states.length; i++) {
    counts[states[i - 1]][states[i]]++;
  }

  const probs: number[][] = counts.map((row) => {
    const tot = row.reduce((a, b) => a + b, 0);
    return tot > 0 ? row.map((c) => Math.round((c / tot) * 1000) / 1000) : [0, 0, 0];
  });

  return {
    states: ['W', 'L', 'L_tilted'],
    transitionMatrix: counts,
    transitionProbabilities: probs,
  };
}

// ─── Interpretation string ────────────────────────────────────────────────

function buildInterpretation(
  probs: TransitionProbabilities,
  test: StatisticalTest,
  overallWinRate: number,
): string {
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

  const base =
    `Your outcomes show ${test.isSignificant ? 'significant' : 'no'} serial dependence. ` +
    `After a win, you win again ${pct(probs.winAfterWin)} of the time ` +
    `(vs ${pct(overallWinRate)} overall). ` +
    `After a loss, you lose again ${pct(probs.lossAfterLoss)} of the time.`;

  if (!test.isSignificant) {
    return base + ' Trade outcomes appear independent — there is no statistical evidence that prior results affect the next trade.';
  }

  // Significant — characterize direction
  const winMomentum  = probs.winAfterWin > overallWinRate + 0.05;
  const lossMomentum = probs.lossAfterLoss > (1 - overallWinRate) + 0.05;

  if (winMomentum && lossMomentum) {
    return base + ' This suggests your behavior changes after wins and losses — possibly overconfidence after wins and tilt or loss-aversion after losses.';
  }
  if (winMomentum) {
    return base + ' Wins cluster more than chance — possibly overconfidence or hot-hand effects after winning.';
  }
  if (lossMomentum) {
    return base + ' Losses cluster more than chance — a hallmark of tilt or revenge trading after a losing trade.';
  }
  return base + ' This suggests your behavior changes after wins/losses, though the direction is mixed.';
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function lag1Autocorrelation(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / n;

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    den += (xs[i] - mean) * (xs[i] - mean);
  }
  for (let i = 0; i < n - 1; i++) {
    num += (xs[i] - mean) * (xs[i + 1] - mean);
  }
  return den > 1e-12 ? num / den : 0;
}

function roundProbs(p: TransitionProbabilities): TransitionProbabilities {
  return {
    winAfterWin:   Math.round(p.winAfterWin   * 1000) / 1000,
    lossAfterWin:  Math.round(p.lossAfterWin  * 1000) / 1000,
    winAfterLoss:  Math.round(p.winAfterLoss  * 1000) / 1000,
    lossAfterLoss: Math.round(p.lossAfterLoss * 1000) / 1000,
  };
}
