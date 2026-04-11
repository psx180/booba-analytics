/**
 * Elo rating metric.
 *
 * Treat each closed position as a "match" between the trader and a market
 * condition (regime × asset). A winning trade beats the condition; a losing
 * trade loses. Both sides update their rating after every match.
 *
 * Implementation uses the standard Elo formulas:
 *   E = 1 / (1 + 10^((R_opp - R_self) / 400))
 *   R_new = R_old + K * (S - E)
 *
 * K-factor steps down after the calibration window (40 → 20 after 30 trades),
 * which is the chess-rating convention for new players who need to settle
 * into their true skill band quickly.
 *
 * Like xPnL, this metric is sequential: position N's Elo depends on positions
 * 0..N-1. It implements `computeAll` so the analytics service runs it once
 * over the full history rather than calling `compute` per-row.
 */

import type { MetricComputer, Position } from './base';

const STARTING_ELO     = 1500;
const K_CALIBRATION    = 40;
const K_STABLE         = 20;
const CALIBRATION_GAME = 30;
const RECENT_TREND_N   = 20;

// ─── Output types ──────────────────────────────────────────────────────────

export type EloTier =
  | 'Beginner'
  | 'Intermediate'
  | 'Advanced'
  | 'Expert'
  | 'Grandmaster';

export interface EloSeriesPoint {
  date: string;
  elo: number;
}

export interface ConditionDifficulty {
  condition: string;
  elo: number;
}

export interface EloResult {
  currentElo: number;
  tier: EloTier;
  peakElo: number;
  peakDate: string | null;
  eloSeries: EloSeriesPoint[];
  conditionDifficulty: ConditionDifficulty[];
  recentTrend: 'improving' | 'declining' | 'stable';
  tradeCount: number;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Walk through positions chronologically and run the Elo updates. Returns
 * both the per-position eloAtTrade map (for the metric persister) and the
 * full result payload (for API and dashboard consumption).
 */
export function computeEloResult(positions: Position[]): EloResult {
  const closed = positions
    .filter(
      (p) => p.aggregatePnl != null && p.firstEntryTime != null,
    )
    .sort(
      (a, b) => a.firstEntryTime!.getTime() - b.firstEntryTime!.getTime(),
    );

  if (closed.length === 0) {
    return {
      currentElo: STARTING_ELO,
      tier: tierFor(STARTING_ELO),
      peakElo: STARTING_ELO,
      peakDate: null,
      eloSeries: [],
      conditionDifficulty: [],
      recentTrend: 'stable',
      tradeCount: 0,
    };
  }

  let traderElo = STARTING_ELO;
  let peakElo = STARTING_ELO;
  let peakDate: string | null = null;
  const conditionElo = new Map<string, number>();
  const series: EloSeriesPoint[] = [];

  for (let i = 0; i < closed.length; i++) {
    const p = closed[i];
    const cond = conditionKey(p);
    const condElo = conditionElo.get(cond) ?? STARTING_ELO;

    const expected = 1 / (1 + Math.pow(10, (condElo - traderElo) / 400));
    const pnl = p.aggregatePnl ?? 0;
    const score = pnl > 0 ? 1 : pnl < 0 ? 0 : 0.5;
    const k = i < CALIBRATION_GAME ? K_CALIBRATION : K_STABLE;

    const delta = k * (score - expected);
    traderElo += delta;
    // Conditions move in the opposite direction with a smaller step:
    // matching the trader-side delta would let one wallet single-handedly
    // shove a regime's rating around. Half-step keeps both sides reactive
    // without one dominating.
    conditionElo.set(cond, condElo - delta * 0.5);

    if (traderElo > peakElo) {
      peakElo = traderElo;
      peakDate = p.lastExitTime?.toISOString() ?? p.firstEntryTime!.toISOString();
    }

    series.push({
      date: (p.lastExitTime ?? p.firstEntryTime!).toISOString(),
      elo: round(traderElo, 1),
    });
  }

  const conditionDifficulty: ConditionDifficulty[] = Array.from(conditionElo.entries())
    .map(([condition, elo]) => ({ condition, elo: round(elo, 1) }))
    .sort((a, b) => b.elo - a.elo);

  return {
    currentElo: round(traderElo, 1),
    tier: tierFor(traderElo),
    peakElo: round(peakElo, 1),
    peakDate,
    eloSeries: series,
    conditionDifficulty,
    recentTrend: trendOver(series, RECENT_TREND_N),
    tradeCount: closed.length,
  };
}

/** Returns the per-position eloAtTrade map produced by walking the chain. */
export function computeEloMap(positions: Position[]): Map<string, number> {
  const result = computeEloResult(positions);
  // Walk again so we can pair each position with its eloAtTrade. We could
  // refactor computeEloResult to return both, but a second tiny pass keeps
  // the public surface clean and the cost is O(n).
  const closed = positions
    .filter(
      (p) => p.aggregatePnl != null && p.firstEntryTime != null,
    )
    .sort(
      (a, b) => a.firstEntryTime!.getTime() - b.firstEntryTime!.getTime(),
    );

  const map = new Map<string, number>();
  for (let i = 0; i < closed.length; i++) {
    const point = result.eloSeries[i];
    if (point) map.set(closed[i].id, point.elo);
  }
  return map;
}

// ─── MetricComputer interface ──────────────────────────────────────────────

export const eloComputer: MetricComputer = {
  name: 'elo',
  requiredFields: ['aggregatePnl', 'firstEntryTime', 'regimeAtEntry', 'asset'],

  // Per-position fallback is a no-op — Elo only makes sense in batch.
  compute(): Record<string, number | string | null> {
    return {};
  },

  computeAll(positions: Position[]): Map<string, Record<string, number | string | null>> {
    const eloMap = computeEloMap(positions);
    const out = new Map<string, Record<string, number | string | null>>();
    for (const [positionId, elo] of eloMap) {
      out.set(positionId, { eloAtTrade: round(elo, 2) });
    }
    return out;
  },
};

// ─── Helpers ───────────────────────────────────────────────────────────────

export function tierFor(elo: number): EloTier {
  if (elo < 1200) return 'Beginner';
  if (elo < 1400) return 'Intermediate';
  if (elo < 1600) return 'Advanced';
  if (elo < 1800) return 'Expert';
  return 'Grandmaster';
}

function conditionKey(p: Position): string {
  const regime = p.regimeAtEntry ?? 'unknown';
  const asset  = p.asset ?? 'unknown';
  return `${regime}|${asset}`;
}

/**
 * Slope of the last `n` Elo points by simple linear regression. Treat slopes
 * within ±0.5 Elo per trade as "stable" — anything tighter is noise on a
 * small window, anything wider is a real direction change.
 */
function trendOver(series: EloSeriesPoint[], n: number): 'improving' | 'declining' | 'stable' {
  if (series.length < 4) return 'stable';
  const tail = series.slice(-Math.min(n, series.length));
  const m = tail.length;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < m; i++) {
    sx += i;
    sy += tail[i].elo;
    sxy += i * tail[i].elo;
    sxx += i * i;
  }
  const denom = m * sxx - sx * sx;
  if (Math.abs(denom) < 1e-9) return 'stable';
  const slope = (m * sxy - sx * sy) / denom;
  if (slope > 0.5) return 'improving';
  if (slope < -0.5) return 'declining';
  return 'stable';
}

function round(value: number, digits: number): number {
  const m = Math.pow(10, digits);
  return Math.round(value * m) / m;
}
