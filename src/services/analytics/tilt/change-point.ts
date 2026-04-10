/**
 * ChangePointDetector — CUSUM-based tilt detection.
 *
 * Builds a "behavioural intensity" signal per position from three features
 * (trade frequency, size, inverted hold time), each z-scored against the
 * full history. The three z-scores are averaged into a single scalar, then
 * a one-sided CUSUM control chart is run over the resulting series:
 *
 *     S_t = max(0, S_{t-1} + (x_t - target - slack))
 *
 * With target = 0 and slack = SLACK_SIGMA, S grows whenever the trader is
 * consistently above their personal baseline. When S exceeds THRESHOLD_SIGMA
 * a tilt episode begins; when it drops back below THRESHOLD_SIGMA * EXIT_FRAC
 * the episode ends.
 *
 * Tuning:
 *   DEFAULT_SLACK = 0.5, DEFAULT_THRESHOLD = 4.0 — spec defaults.
 *   LOOSER_SLACK  = 0.3, LOOSER_THRESHOLD  = 3.0 — automatic fallback if
 *   the tight settings catch zero episodes. This keeps the detector
 *   adaptive without the caller needing to tune it.
 *
 * Scores:
 *   Positions inside an episode get score = min(1, S_t / (2 * threshold)).
 *   Positions outside episodes get score = magnitude of their individual
 *   signal, clipped to [0, 1). A calm trader sits near 0; a single
 *   above-average trade nudges toward the low end.
 */

import type { Position } from '../types';
import type {
  TiltDetector,
  TiltDetectionResult,
  TiltScore,
  TiltEpisode,
  TiltFeatures,
} from './types';

const DEFAULT_SLACK     = 0.5;
const DEFAULT_THRESHOLD = 4.0;
const LOOSER_SLACK      = 0.3;
const LOOSER_THRESHOLD  = 3.0;
const EXIT_FRAC         = 0.5;   // CUSUM must drop below threshold*EXIT_FRAC to end episode
const EPS               = 1e-12;

export interface ChangePointOptions {
  slack?: number;
  threshold?: number;
  verbose?: boolean;
}

export class ChangePointDetector implements TiltDetector {
  name = 'change-point';

  constructor(private readonly opts: ChangePointOptions = {}) {}

  detect(positions: Position[]): TiltDetectionResult {
    const sorted = sortChronologically(positions);
    if (sorted.length === 0) return { scores: [], episodes: [] };

    // 1. Build per-position features and the combined behavioural signal.
    const rawFeatures = sorted.map((p, i) => computeRawFeatures(p, sorted.slice(0, i)));
    const signal      = buildSignal(rawFeatures);

    const slack     = this.opts.slack     ?? DEFAULT_SLACK;
    const threshold = this.opts.threshold ?? DEFAULT_THRESHOLD;

    // 2. Run CUSUM. If nothing trips, retry with looser params (but only
    //    when the caller is using defaults — an explicit opts override is
    //    respected as-is).
    let run = runCusum(sorted, signal, slack, threshold, this.opts.verbose === true);
    if (run.episodes.length === 0 && this.opts.slack == null && this.opts.threshold == null) {
      if (this.opts.verbose) {
        console.log(
          `[tilt:change-point] no episodes at slack=${slack} threshold=${threshold}, ` +
          `retrying with slack=${LOOSER_SLACK} threshold=${LOOSER_THRESHOLD}`,
        );
      }
      run = runCusum(sorted, signal, LOOSER_SLACK, LOOSER_THRESHOLD, this.opts.verbose === true);
    }

    // 3. Build TiltScore objects — richer TiltFeatures based on the
    //    spec's shape (ratios, not z-scores) so downstream consumers get
    //    something consistent across detectors.
    const scores: TiltScore[] = sorted.map((position, i) => {
      const tiltFeatures = buildTiltFeatures(position, sorted.slice(0, i), rawFeatures[i]);
      const inEpisode    = run.episodeByIndex[i];
      const baseScore    = inEpisode
        ? Math.min(1, run.cusum[i] / (2 * run.effectiveThreshold))
        : Math.min(0.5, Math.max(0, signal[i]) / 4); // outside-episode baseline
      return {
        positionId: position.id,
        score     : round(baseScore),
        features  : tiltFeatures,
        episodeId : inEpisode ?? null,
      };
    });

    // 4. Fill pnlOutsideEpisodes for every episode.
    const episodePositionIds = new Set(run.episodes.flatMap((e) => e.positionIds));
    const pnlOutsideEpisodes = sum(
      sorted
        .filter((p) => !episodePositionIds.has(p.id))
        .map((p) => p.aggregatePnl ?? 0),
    );
    for (const ep of run.episodes) ep.pnlOutsideEpisodes = pnlOutsideEpisodes;

    return { scores, episodes: run.episodes };
  }
}

// ─── Signal construction ─────────────────────────────────────────────────────

interface RawFeatures {
  frequency: number | null; // 1 / (gap seconds); null for first trade / missing data
  size     : number | null;
  holdTime : number | null;
}

function computeRawFeatures(position: Position, prior: Position[]): RawFeatures {
  const prev      = prior[prior.length - 1];
  const gap       = prev && prev.lastExitTime && position.firstEntryTime
    ? (position.firstEntryTime.getTime() - prev.lastExitTime.getTime()) / 1000
    : null;
  const frequency = gap != null && gap > 0 ? 1 / gap : null;

  return {
    frequency,
    size    : position.totalSize != null && position.totalSize > 0 ? position.totalSize : null,
    holdTime: position.holdTimeSeconds != null && position.holdTimeSeconds > 0 ? position.holdTimeSeconds : null,
  };
}

/**
 * Turn raw features into a combined z-scored behavioural intensity signal.
 * Each component is z-scored on log values to compress heavy tails common
 * in trade size / frequency distributions.
 */
function buildSignal(raws: RawFeatures[]): number[] {
  const logFreq = raws.map((r) => r.frequency != null ? Math.log(r.frequency) : null);
  const logSize = raws.map((r) => r.size      != null ? Math.log(r.size)      : null);
  const logHold = raws.map((r) => r.holdTime  != null ? Math.log(r.holdTime)  : null);

  const fz = zScore(logFreq);
  const sz = zScore(logSize);
  // Hold time is inverted: shorter hold → higher intensity.
  const hz = zScore(logHold).map((z) => z == null ? null : -z);

  const out: number[] = [];
  for (let i = 0; i < raws.length; i++) {
    const parts = [fz[i], sz[i], hz[i]].filter((x): x is number => x != null);
    out.push(parts.length === 0 ? 0 : sum(parts) / parts.length);
  }
  return out;
}

/**
 * z-score a vector, ignoring nulls. Returns an array of the same length
 * with null entries where the input was null.
 */
function zScore(xs: Array<number | null>): Array<number | null> {
  const vals = xs.filter((x): x is number => x != null && Number.isFinite(x));
  if (vals.length < 2) return xs.map(() => 0);
  const mu    = sum(vals) / vals.length;
  const varSq = sum(vals.map((v) => (v - mu) ** 2)) / (vals.length - 1);
  const sigma = Math.sqrt(varSq);
  if (sigma < EPS) return xs.map(() => 0);
  return xs.map((x) => x == null ? null : (x - mu) / sigma);
}

// ─── CUSUM ───────────────────────────────────────────────────────────────────

interface CusumRun {
  cusum            : number[];
  episodes         : TiltEpisode[];
  episodeByIndex   : Array<string | null>;
  effectiveSlack   : number;
  effectiveThreshold: number;
}

function runCusum(
  sorted: Position[],
  signal: number[],
  slack: number,
  threshold: number,
  verbose: boolean,
): CusumRun {
  const n      = signal.length;
  const cusum  = new Array<number>(n).fill(0);
  const episodeByIndex: Array<string | null> = new Array(n).fill(null);
  const episodes: TiltEpisode[] = [];

  let s             = 0;
  let inEpisode     = false;
  let episodeStart  = -1;
  let peakCusum     = 0;

  for (let i = 0; i < n; i++) {
    s = Math.max(0, s + (signal[i] - slack));
    cusum[i] = s;

    if (verbose) {
      console.log(
        `[tilt:change-point] i=${i} id=${sorted[i].id} ` +
        `time=${sorted[i].firstEntryTime?.toISOString() ?? '?'} ` +
        `signal=${signal[i].toFixed(3)} S=${s.toFixed(3)} threshold=${threshold.toFixed(2)}`,
      );
    }

    if (!inEpisode && s > threshold) {
      inEpisode    = true;
      // Walk back to find where S started rising from 0 — that's the true start.
      episodeStart = findEpisodeStart(cusum, i);
      peakCusum    = s;
    } else if (inEpisode) {
      peakCusum = Math.max(peakCusum, s);
      if (s < threshold * EXIT_FRAC) {
        episodes.push(buildEpisode(
          sorted, episodeStart, i, peakCusum, threshold,
        ));
        inEpisode    = false;
        episodeStart = -1;
        peakCusum    = 0;
      }
    }
  }

  // Flush an open episode at the end of the history.
  if (inEpisode) {
    episodes.push(buildEpisode(
      sorted, episodeStart, n - 1, peakCusum, threshold,
    ));
  }

  // Mark episode membership.
  for (const ep of episodes) {
    for (const pid of ep.positionIds) {
      const idx = sorted.findIndex((p) => p.id === pid);
      if (idx >= 0) episodeByIndex[idx] = ep.id;
    }
    if (verbose) {
      console.log(
        `[tilt:change-point] episode ${ep.id}: ` +
        `${ep.startTime.toISOString()} → ${ep.endTime?.toISOString() ?? 'open'} ` +
        `N=${ep.positionIds.length} severity=${ep.severity.toFixed(2)} trigger=${ep.trigger}`,
      );
    }
  }

  return {
    cusum,
    episodes,
    episodeByIndex,
    effectiveSlack    : slack,
    effectiveThreshold: threshold,
  };
}

/** Walk back through the cumulative sum to find the last zero before trip. */
function findEpisodeStart(cusum: number[], tripIndex: number): number {
  for (let j = tripIndex - 1; j >= 0; j--) {
    if (cusum[j] <= 0) return j + 1;
  }
  return 0;
}

function buildEpisode(
  sorted: Position[],
  fromIdx: number,
  toIdx: number,
  peakCusum: number,
  threshold: number,
): TiltEpisode {
  const members = sorted.slice(fromIdx, toIdx + 1);
  const id      = `tilt-cp-${members[0].id}`;

  // Trigger heuristic: look at what was happening in the few trades leading
  // up to (and including) the start. If the 3 prior trades were losing,
  // call it consecutive_losses. Else if their combined P&L was a large
  // drawdown, call it drawdown. Otherwise behavioral_shift.
  const lookback = sorted.slice(Math.max(0, fromIdx - 3), fromIdx + 1);
  const trigger  = inferTrigger(lookback);

  return {
    id,
    startTime         : members[0].firstEntryTime ?? new Date(0),
    endTime           : members[members.length - 1].lastExitTime ?? null,
    trigger,
    positionIds       : members.map((p) => p.id),
    severity          : Math.min(1, peakCusum / (threshold * 2)),
    pnlDuringEpisode  : sum(members.map((p) => p.aggregatePnl ?? 0)),
    pnlOutsideEpisodes: 0, // filled in by caller
  };
}

function inferTrigger(lookback: Position[]): string {
  if (lookback.length === 0) return 'behavioral_shift';
  const pnls = lookback.map((p) => p.aggregatePnl ?? 0);
  const losses = pnls.filter((v) => v < 0);
  if (losses.length >= 3) return 'consecutive_losses';
  const totalPnl = sum(pnls);
  if (totalPnl < 0) {
    // A single large loss dwarfs the others.
    const worst = Math.min(...pnls);
    const rest  = totalPnl - worst;
    if (Math.abs(worst) > Math.abs(rest) * 2) return 'large_loss';
    return 'drawdown';
  }
  return 'behavioral_shift';
}

// ─── TiltFeatures construction (for storage, mirroring heuristic shape) ─────

function buildTiltFeatures(
  position: Position,
  prior: Position[],
  raw: RawFeatures,
): TiltFeatures {
  const baseline = prior.slice(-20);
  const recent   = prior.slice(-5);

  // timeSinceLastLoss
  let timeSinceLastLoss: number | null = null;
  if (prior.length > 0 && position.firstEntryTime) {
    const prev = prior[prior.length - 1];
    if ((prev.aggregatePnl ?? 0) < 0 && prev.lastExitTime) {
      const seconds = (position.firstEntryTime.getTime() - prev.lastExitTime.getTime()) / 1000;
      if (seconds >= 0) timeSinceLastLoss = seconds;
    }
  }

  const recentLossCount = recent.filter((p) => (p.aggregatePnl ?? 0) < 0).length;

  const baselineSize = meanNonNull(baseline.map((p) => p.totalSize));
  const sizeRatio    = baselineSize > 0 && raw.size != null ? raw.size / baselineSize : 1;

  const baselineHold = meanNonNull(baseline.map((p) => p.holdTimeSeconds));
  const holdRatio    = baselineHold > 0 && raw.holdTime != null ? raw.holdTime / baselineHold : 1;

  // frequencyVsAverage mirroring heuristic: recent gap / baseline gap.
  const baselineGap = meanGapSeconds(baseline);
  const prev        = prior[prior.length - 1];
  const recentGap   = prev && prev.lastExitTime && position.firstEntryTime
    ? Math.max(0, (position.firstEntryTime.getTime() - prev.lastExitTime.getTime()) / 1000)
    : null;
  const freqRatio = baselineGap > 0 && recentGap != null ? recentGap / baselineGap : 1;

  const rollingPnl = sum(recent.map((p) => p.aggregatePnl ?? 0));

  return {
    timeSinceLastLoss,
    recentLossCount,
    sizeVsAverage     : sizeRatio,
    frequencyVsAverage: freqRatio,
    holdTimeVsAverage : holdRatio,
    rollingPnl,
  };
}

// ─── Small utilities (duplicated locally to keep modules independent) ──────

function sortChronologically(positions: Position[]): Position[] {
  return [...positions]
    .filter((p) => p.firstEntryTime != null)
    .sort((a, b) => a.firstEntryTime!.getTime() - b.firstEntryTime!.getTime());
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function meanNonNull(xs: Array<number | null | undefined>): number {
  const vals = xs.filter((x): x is number => x != null && Number.isFinite(x));
  return vals.length === 0 ? 0 : sum(vals) / vals.length;
}

function meanGapSeconds(slice: Position[]): number {
  if (slice.length < 2) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    const prevExit  = slice[i - 1].lastExitTime;
    const thisEntry = slice[i].firstEntryTime;
    if (prevExit && thisEntry) {
      const gap = (thisEntry.getTime() - prevExit.getTime()) / 1000;
      if (gap >= 0) gaps.push(gap);
    }
  }
  return gaps.length === 0 ? 0 : sum(gaps) / gaps.length;
}

function round(x: number): number {
  return Math.round(x * 10000) / 10000;
}
