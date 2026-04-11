/**
 * WART — Wins Above Replacement Trader.
 *
 * A composite trader score adapted from baseball's WAR. Five axes, each
 * scored 0-100, weighted into a single number, then mapped to a -5/+5 scale
 * centered on 0 (perfectly average trader).
 *
 *   axis             weight   primary signal              fallback
 *   ────────────────────────────────────────────────────────────────────
 *   entry            0.25     xPnL luck score             win rate vs 50%
 *   exit             0.20     MFE exit efficiency         disposition ratio vs 1.2
 *   risk             0.25     position-size CV (+ DD)     —
 *   timing           0.15     best-session concentration  neutral 50
 *   discipline       0.15     Shannon entropy composite   tilt episode rate
 *
 * WART is **not** a MetricComputer — nothing here is stored on the Position
 * row. It's computed on demand from existing metric/insight outputs and the
 * underwater drawdown data emitted by the equity-curve aggregator.
 */

import type { Position } from './base';
import type { XpnlResult } from './xpnl';
import type { EntropyResult } from '../insights/entropy-insight';
import { computeDispositionRatio } from '../insights/disposition';

// ─── Output types ──────────────────────────────────────────────────────────

export interface WartAxis {
  score: number;
  method: string;
  details: string;
}

export interface WartResult {
  /** WART number, typically -5 to +5. 0 = perfectly average trader. */
  composite: number;
  tier: string;
  axes: {
    entry: WartAxis;
    exit: WartAxis;
    risk: WartAxis;
    timing: WartAxis;
    discipline: WartAxis;
  };
  /** 0-100 weighted score before WART conversion. */
  weightedScore: number;
  /** Top 2-3 actionable recommendations based on the weakest axes. */
  improvements: string[];
  tradeCount: number;
}

export interface WartDeps {
  xpnlResult?: XpnlResult;
  entropyResult?: EntropyResult;
  /** From equity-curve aggregator's data field. */
  drawdown?: {
    maxDrawdown: number;
    maxDrawdownPct: number;
    maxDrawdownDuration: number;
    currentDrawdown: number;
  };
  /** Total number of trades in the equity curve, for the duration ratio. */
  equityCurveTradeCount?: number;
}

const WEIGHTS = {
  entry:      0.25,
  exit:       0.20,
  risk:       0.25,
  timing:     0.15,
  discipline: 0.15,
} as const;

// ─── Public API ────────────────────────────────────────────────────────────

export function computeWartResult(positions: Position[], deps: WartDeps = {}): WartResult {
  const closed = positions.filter(
    (p) => p.status === 'closed' && p.aggregatePnl != null,
  );

  const entry      = computeEntryAxis(closed, deps.xpnlResult);
  const exit       = computeExitAxis(closed);
  const risk       = computeRiskAxis(closed, deps.drawdown, deps.equityCurveTradeCount);
  const timing     = computeTimingAxis(closed);
  const discipline = computeDisciplineAxis(closed, deps.entropyResult);

  const weightedScore =
    WEIGHTS.entry      * entry.score +
    WEIGHTS.exit       * exit.score +
    WEIGHTS.risk       * risk.score +
    WEIGHTS.timing     * timing.score +
    WEIGHTS.discipline * discipline.score;

  const composite = round((weightedScore - 50) / 10, 2);
  const tier = tierFromWart(composite);

  const axes = { entry, exit, risk, timing, discipline };
  const improvements = buildImprovements(axes);

  return {
    composite,
    tier,
    axes,
    weightedScore: round(weightedScore, 1),
    improvements,
    tradeCount: closed.length,
  };
}

export function tierFromWart(wart: number): string {
  if (wart < -2.0) return 'Struggling';
  if (wart <  0.0) return 'Below Average';
  if (wart <  1.0) return 'Average';
  if (wart <  2.0) return 'Above Average';
  if (wart <  3.0) return 'Strong';
  return 'Elite';
}

// ─── Axis computations ────────────────────────────────────────────────────

function computeEntryAxis(positions: Position[], xpnlResult?: XpnlResult): WartAxis {
  // Primary: xPnL luckScore. Positive luckScore = entries beat expectations.
  if (xpnlResult && xpnlResult.positions.length > 0) {
    const luckScore = xpnlResult.luckScore;
    const score = clamp(50 + luckScore * 100, 0, 100);
    return {
      score: round(score, 1),
      method: 'xpnl_luck',
      details: `Luck score ${(luckScore * 100).toFixed(1)}% — actual P&L vs xPnL benchmark`,
    };
  }

  // Fallback: win rate vs random baseline.
  const winners = positions.filter((p) => (p.aggregatePnl ?? 0) > 0).length;
  const total   = positions.length;
  const winRate = total > 0 ? winners / total : 0.5;
  const score = clamp(winRate * 100, 0, 100);
  return {
    score: round(score, 1),
    method: 'win_rate',
    details: `Win rate ${(winRate * 100).toFixed(1)}% (xPnL data unavailable)`,
  };
}

function computeExitAxis(positions: Position[]): WartAxis {
  // Primary: average exit efficiency on winning trades.
  const winnersWithMfe = positions.filter(
    (p) => (p.aggregatePnl ?? 0) > 0 && p.mfePnl != null && p.mfePnl > 0,
  );
  if (winnersWithMfe.length >= 5) {
    let sum = 0;
    let n = 0;
    for (const p of winnersWithMfe) {
      const eff = (p.aggregatePnl ?? 0) / (p.mfePnl ?? 1);
      // Cap individual ratios at 1.0 — actualPnl shouldn't exceed mfePnl,
      // but rounding/timing edge cases occasionally produce >1.
      sum += Math.min(1, Math.max(0, eff));
      n++;
    }
    const efficiency = n > 0 ? sum / n : 0;
    const score = clamp(efficiency * 100, 0, 100);
    return {
      score: round(score, 1),
      method: 'mfe_efficiency',
      details: `Capturing ${(efficiency * 100).toFixed(0)}% of available profit (MFE basis, ${n} winners)`,
    };
  }

  // Fallback: disposition ratio. Ideal ratio is 1.2 (winners held slightly
  // longer than losers). Distance from 1.2 in either direction reduces score.
  const ratio = computeDispositionRatio(positions);
  if (ratio == null) {
    return {
      score: 50,
      method: 'neutral',
      details: 'Insufficient MFE and hold-time data — neutral score',
    };
  }
  // Ratio is loserHold / winnerHold. We want winnerHold / loserHold ≈ 1.2.
  // Convert: a ratio of 1/1.2 ≈ 0.833 means winners held 1.2x as long as losers.
  // To match the spec wording ("ratio of 1.2 = ideal"), invert if needed.
  // The disposition.ts ratio is loser/winner; we want winner/loser. Invert.
  const winnerLoserRatio = ratio > 0 ? 1 / ratio : 0;
  const score = clamp(100 - Math.abs(winnerLoserRatio - 1.2) * 40, 0, 100);
  return {
    score: round(score, 1),
    method: 'disposition',
    details: `Winner/loser hold ratio ${winnerLoserRatio.toFixed(2)} (ideal 1.2; MFE data unavailable)`,
  };
}

function computeRiskAxis(
  positions: Position[],
  drawdown?: WartDeps['drawdown'],
  equityCurveTradeCount?: number,
): WartAxis {
  // Position size CV. Lower CV = more consistent sizing.
  const sizes = positions
    .map((p) => p.totalSize ?? 0)
    .filter((s) => s > 0);

  if (sizes.length < 2) {
    return {
      score: 50,
      method: 'insufficient_data',
      details: 'Not enough sized trades to measure consistency',
    };
  }

  const mean = sizes.reduce((s, v) => s + v, 0) / sizes.length;
  if (mean === 0) {
    return {
      score: 50,
      method: 'insufficient_data',
      details: 'Zero mean position size — cannot compute CV',
    };
  }
  const variance = sizes.reduce((s, v) => s + (v - mean) ** 2, 0) / sizes.length;
  const stdev = Math.sqrt(variance);
  const cv = stdev / mean;

  let score = clamp(100 - cv * 100, 0, 100);

  // Bonus: if max drawdown duration < 20% of total trading period, add 10.
  let bonusApplied = false;
  if (drawdown && equityCurveTradeCount && equityCurveTradeCount > 0) {
    const ddRatio = drawdown.maxDrawdownDuration / equityCurveTradeCount;
    if (ddRatio < 0.20) {
      score = clamp(score + 10, 0, 100);
      bonusApplied = true;
    }
  }

  const ddNote = drawdown
    ? `; max DD $${Math.abs(drawdown.maxDrawdown).toFixed(0)} over ${drawdown.maxDrawdownDuration} trades${bonusApplied ? ' (+10 bonus)' : ''}`
    : '';
  return {
    score: round(score, 1),
    method: 'size_cv',
    details: `Position size CV ${cv.toFixed(2)}${ddNote}`,
  };
}

function computeTimingAxis(positions: Position[]): WartAxis {
  // Concentrate activity in best session.
  const sessionStats = new Map<string, { count: number; pnl: number }>();
  for (const p of positions) {
    const session = p.entrySession;
    if (!session) continue;
    const cur = sessionStats.get(session) ?? { count: 0, pnl: 0 };
    cur.count += 1;
    cur.pnl   += p.aggregatePnl ?? 0;
    sessionStats.set(session, cur);
  }

  const sessions = Array.from(sessionStats.entries());
  if (sessions.length < 2) {
    return {
      score: 50,
      method: 'neutral',
      details: 'Insufficient session diversity to measure timing edge',
    };
  }

  const totalCount = sessions.reduce((s, [, v]) => s + v.count, 0);
  const totalPnl   = sessions.reduce((s, [, v]) => s + v.pnl,   0);

  // Identify best session by P&L. If totalPnl ≤ 0 or all sessions are
  // roughly equal, fall back to neutral 50 — there's no edge to exploit.
  if (totalPnl <= 0) {
    return {
      score: 50,
      method: 'neutral',
      details: 'No positive session edge — neutral score',
    };
  }

  let best = sessions[0];
  for (const s of sessions) {
    if (s[1].pnl > best[1].pnl) best = s;
  }
  const [bestName, bestStats] = best;
  if (bestStats.pnl <= 0) {
    return {
      score: 50,
      method: 'neutral',
      details: 'Best session has no positive edge — neutral score',
    };
  }

  const countShare = bestStats.count / totalCount;
  const pnlShare   = bestStats.pnl   / totalPnl;
  // Spec formula: countShare * 100 + pnlShare * 50, normalized to 0-100.
  // Max raw value is 150 (100% count + 100% pnl), so divide by 1.5.
  const raw = countShare * 100 + pnlShare * 50;
  const score = clamp(raw / 1.5, 0, 100);

  return {
    score: round(score, 1),
    method: 'best_session',
    details: `Best session: ${bestName} (${(countShare * 100).toFixed(0)}% of trades, ${(pnlShare * 100).toFixed(0)}% of P&L)`,
  };
}

function computeDisciplineAxis(positions: Position[], entropyResult?: EntropyResult): WartAxis {
  if (entropyResult && entropyResult.tradeCount > 0) {
    const score = clamp(entropyResult.compositeScore, 0, 100);
    return {
      score: round(score, 1),
      method: 'entropy',
      details: `Shannon entropy discipline ${entropyResult.compositeScore.toFixed(0)}/100 (${entropyResult.trend})`,
    };
  }

  // Fallback: tilt episode density.
  const tiltEpisodeIds = new Set<string>();
  for (const p of positions) {
    if (p.tiltEpisodeId) tiltEpisodeIds.add(p.tiltEpisodeId);
  }
  const total = positions.length;
  if (total === 0) {
    return { score: 50, method: 'neutral', details: 'No trades to score' };
  }
  const score = clamp(100 - (tiltEpisodeIds.size / total) * 500, 0, 100);
  return {
    score: round(score, 1),
    method: 'tilt_episodes',
    details: `${tiltEpisodeIds.size} tilt episode${tiltEpisodeIds.size === 1 ? '' : 's'} across ${total} trades`,
  };
}

// ─── Improvements builder ─────────────────────────────────────────────────

function buildImprovements(axes: WartResult['axes']): string[] {
  // Sort axes ascending by score; pick the bottom 2-3 to recommend on.
  const ordered = (Object.entries(axes) as [keyof WartResult['axes'], WartAxis][])
    .sort(([, a], [, b]) => a.score - b.score);

  const out: string[] = [];
  for (const [name, axis] of ordered.slice(0, 3)) {
    // Only suggest improvements for axes that are actually weak (<60).
    // If all axes are above 60, only flag the worst one.
    if (axis.score >= 60 && out.length > 0) break;

    const text = improvementText(name, axis);
    if (text) out.push(text);
  }
  if (out.length === 0 && ordered.length > 0) {
    const [worstName, worstAxis] = ordered[0];
    const text = improvementText(worstName, worstAxis);
    if (text) out.push(text);
  }
  return out;
}

function improvementText(name: keyof WartResult['axes'], axis: WartAxis): string | null {
  switch (name) {
    case 'risk': {
      const cvMatch = axis.details.match(/CV ([\d.]+)/);
      const cv = cvMatch ? cvMatch[1] : '?';
      return `Your position sizing is erratic (CV = ${cv}). Standardizing to fixed-fractional sizing could improve consistency.`;
    }
    case 'exit': {
      if (axis.method === 'mfe_efficiency') {
        const pctMatch = axis.details.match(/Capturing (\d+)%/);
        const pct = pctMatch ? pctMatch[1] : '?';
        return `You're capturing only ${pct}% of available profit. Consider holding winners longer based on your MFE data.`;
      }
      return `Your exit timing is uneven. Aim to hold winners about 1.2× as long as losers based on disposition analysis.`;
    }
    case 'discipline': {
      return `Your trading entropy is high — you're scattered across many setups. Focusing on fewer, repeatable patterns could improve results.`;
    }
    case 'timing': {
      const sessionMatch = axis.details.match(/Best session: (\w+)/);
      const session = sessionMatch ? sessionMatch[1] : 'your best session';
      return `Your best performance is during the ${session} session. Concentrating activity there could lift overall returns.`;
    }
    case 'entry': {
      if (axis.method === 'xpnl_luck') {
        return `Your entries underperform expectations. Review your entry criteria — your trade selection may be deteriorating.`;
      }
      return `Your win rate is below average. Tighten entry criteria — your trade selection may be too loose.`;
    }
    default:
      return null;
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function round(value: number, digits: number): number {
  const m = Math.pow(10, digits);
  return Math.round(value * m) / m;
}
