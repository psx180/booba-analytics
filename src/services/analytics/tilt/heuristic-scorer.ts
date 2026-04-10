/**
 * HeuristicScorer — a fast, hand-tuned tilt detector.
 *
 * For each position, it builds a baseline from the most recent 20 prior
 * trades (or however many exist) and derives six normalised features:
 *
 *   timeSinceLastLoss  — how long since the last losing trade closed
 *   recentLossCount    — losses in the last 5 trades
 *   sizeVsAverage      — how much this trade's size deviates from baseline
 *   frequencyVsAverage — how much faster than baseline this trade arrived
 *   holdTimeVsAverage  — how much shorter than baseline the hold was
 *   rollingPnl         — rolling P&L over the last 5 trades
 *
 * These are combined with weights from the spec into a single score in
 * [0, 1]. Consecutive positions with score > EPISODE_THRESHOLD are grouped
 * into episodes; the dominant feature of the first position in the group
 * becomes the episode's trigger.
 */

import type { Position } from '../types';
import type {
  TiltDetector,
  TiltDetectionResult,
  TiltScore,
  TiltEpisode,
  TiltFeatures,
} from './types';

const BASELINE_WINDOW      = 20;       // trades used to compute rolling baseline
const RECENT_WINDOW        = 5;        // trades used for recent-loss count & rolling P&L
const LOSS_RECENCY_MAX_SEC = 3600;     // after an hour, "time since last loss" scores 0
const SIZE_DEVIATION_CAP   = 2.0;      // |size/baseline - 1| above this saturates to 1.0
const EPISODE_THRESHOLD    = 0.5;

const WEIGHTS = {
  timeSinceLastLoss : 0.25,
  recentLossCount   : 0.20,
  sizeVsAverage     : 0.20,
  frequencyVsAverage: 0.15,
  holdTimeVsAverage : 0.10,
  rollingPnl        : 0.10,
} as const;

export class HeuristicScorer implements TiltDetector {
  name = 'heuristic-scorer';

  detect(positions: Position[]): TiltDetectionResult {
    const sorted = sortChronologically(positions);

    const scores: TiltScore[] = [];
    const contributions: Record<string, number>[] = [];

    for (let i = 0; i < sorted.length; i++) {
      const position = sorted[i];
      const prior    = sorted.slice(0, i);

      const features = computeFeatures(position, prior);
      const { score, parts } = weightedScore(features, position, prior);

      scores.push({
        positionId: position.id,
        score,
        features,
        episodeId: null,
      });
      contributions.push(parts);
    }

    // Episode detection — consecutive positions with score > threshold.
    const episodes: TiltEpisode[] = [];
    let   runStart: number | null = null;
    let   runMaxScore = 0;

    for (let i = 0; i < scores.length; i++) {
      const s = scores[i];
      if (s.score > EPISODE_THRESHOLD) {
        if (runStart === null) {
          runStart    = i;
          runMaxScore = s.score;
        } else {
          runMaxScore = Math.max(runMaxScore, s.score);
        }
      } else if (runStart !== null) {
        episodes.push(buildEpisode(runStart, i - 1, runMaxScore, sorted, scores, contributions));
        runStart    = null;
        runMaxScore = 0;
      }
    }
    // Flush a run that reaches the end of the history.
    if (runStart !== null) {
      episodes.push(buildEpisode(runStart, scores.length - 1, runMaxScore, sorted, scores, contributions));
    }

    // Compute pnlOutsideEpisodes once and copy to every episode for convenience.
    const episodePositionIds = new Set(episodes.flatMap((e) => e.positionIds));
    const pnlOutsideEpisodes = sum(
      sorted
        .filter((p) => !episodePositionIds.has(p.id))
        .map((p) => p.aggregatePnl ?? 0),
    );
    for (const ep of episodes) ep.pnlOutsideEpisodes = pnlOutsideEpisodes;

    // Attach episodeId to each score that belongs to an episode.
    for (const ep of episodes) {
      const memberIds = new Set(ep.positionIds);
      for (const s of scores) if (memberIds.has(s.positionId)) s.episodeId = ep.id;
    }

    return { scores, episodes };
  }
}

// ─── Feature computation ─────────────────────────────────────────────────────

function computeFeatures(position: Position, prior: Position[]): TiltFeatures {
  const baseline      = prior.slice(-BASELINE_WINDOW);
  const recent        = prior.slice(-RECENT_WINDOW);

  // timeSinceLastLoss — seconds since the immediately preceding loss closed.
  // We look at the most recently closed losing position, not simply the
  // previous-in-sequence position (the preceding trade might itself be open
  // or a win). Spec says "the immediately preceding position" — we interpret
  // strictly: if the previous-in-sequence trade was not a loss, the feature
  // is null and scores 0.
  let timeSinceLastLoss: number | null = null;
  if (prior.length > 0 && position.firstEntryTime) {
    const prev = prior[prior.length - 1];
    const prevPnl = prev.aggregatePnl ?? 0;
    if (prevPnl < 0 && prev.lastExitTime) {
      const seconds = (position.firstEntryTime.getTime() - prev.lastExitTime.getTime()) / 1000;
      if (seconds >= 0) timeSinceLastLoss = seconds;
    }
  }

  // recentLossCount — losses in the last RECENT_WINDOW trades.
  const recentLossCount = recent.filter((p) => (p.aggregatePnl ?? 0) < 0).length;

  // sizeVsAverage — ratio this/baseline (raw, before normalisation).
  const baselineSize = meanOfNonNull(baseline.map((p) => p.totalSize));
  const thisSize     = position.totalSize ?? 0;
  const sizeRatio    = baselineSize > 0 ? thisSize / baselineSize : 1;

  // frequencyVsAverage — ratio recentGap/baselineGap. If recent gap is
  // shorter than baseline, the trader is trading faster than usual.
  const baselineFreqSeconds = meanGapSeconds(baseline);
  const recentGapSeconds    = prior.length > 0 && position.firstEntryTime && prior[prior.length - 1].lastExitTime
    ? Math.max(0, (position.firstEntryTime.getTime() - prior[prior.length - 1].lastExitTime!.getTime()) / 1000)
    : null;
  const freqRatio = baselineFreqSeconds && recentGapSeconds != null
    ? recentGapSeconds / baselineFreqSeconds
    : 1;

  // holdTimeVsAverage — ratio thisHold/baselineHold.
  const baselineHold = meanOfNonNull(baseline.map((p) => (p.holdTimeSeconds ?? null) as number | null));
  const thisHold     = position.holdTimeSeconds ?? null;
  const holdRatio    = baselineHold > 0 && thisHold != null ? thisHold / baselineHold : 1;

  // rollingPnl — sum over the recent window.
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

function weightedScore(
  features: TiltFeatures,
  position: Position,
  prior: Position[],
): { score: number; parts: Record<string, number> } {
  // 1) timeSinceLastLoss → 0-1. Closer to a loss = higher.
  const lossProximity = features.timeSinceLastLoss == null
    ? 0
    : Math.max(0, 1 - features.timeSinceLastLoss / LOSS_RECENCY_MAX_SEC);

  // 2) recentLossCount → 0-1 over 0..RECENT_WINDOW.
  const lossDensity = Math.min(1, features.recentLossCount / RECENT_WINDOW);

  // 3) sizeVsAverage → |ratio - 1|, capped, normalised. Both oversize
  //    and undersize count as behavioural deviations.
  const sizeDeviation = Math.min(SIZE_DEVIATION_CAP, Math.abs(features.sizeVsAverage - 1)) / SIZE_DEVIATION_CAP;

  // 4) frequencyVsAverage → score only when trading faster than baseline.
  const frequencyDeviation = features.frequencyVsAverage < 1
    ? 1 - features.frequencyVsAverage
    : 0;

  // 5) holdTimeVsAverage → score only when hold is materially shorter
  //    (< 50% of baseline). Shorter-than-normal holds suggest impulsivity.
  const holdDeviation = features.holdTimeVsAverage < 0.5
    ? 1 - features.holdTimeVsAverage
    : 0;

  // 6) rollingPnl → negative rolling P&L maps to a positive score.
  //    Normalise against the prior-window's mean absolute P&L so one
  //    outsized loss doesn't saturate the feature forever.
  const meanAbsPnl = meanOfNonNull(
    prior.slice(-BASELINE_WINDOW).map((p) => p.aggregatePnl != null ? Math.abs(p.aggregatePnl) : null),
  );
  const rollingPnlScore = features.rollingPnl < 0 && meanAbsPnl > 0
    ? Math.min(1, Math.abs(features.rollingPnl) / (meanAbsPnl * RECENT_WINDOW))
    : 0;

  const parts: Record<string, number> = {
    timeSinceLastLoss : WEIGHTS.timeSinceLastLoss  * lossProximity,
    recentLossCount   : WEIGHTS.recentLossCount    * lossDensity,
    sizeVsAverage     : WEIGHTS.sizeVsAverage      * sizeDeviation,
    frequencyVsAverage: WEIGHTS.frequencyVsAverage * frequencyDeviation,
    holdTimeVsAverage : WEIGHTS.holdTimeVsAverage  * holdDeviation,
    rollingPnl        : WEIGHTS.rollingPnl         * rollingPnlScore,
  };

  const score = Math.min(1, Math.max(0, sum(Object.values(parts))));
  return { score, parts };
}

// ─── Episode construction ────────────────────────────────────────────────────

function buildEpisode(
  fromIdx: number,
  toIdx: number,
  severity: number,
  sorted: Position[],
  scores: TiltScore[],
  contributions: Record<string, number>[],
): TiltEpisode {
  const members = sorted.slice(fromIdx, toIdx + 1);
  const id      = `tilt-h-${members[0].id}`;

  const startTime = members[0].firstEntryTime ?? new Date(0);
  const lastMember = members[members.length - 1];
  const endTime    = lastMember.lastExitTime ?? null;

  // Trigger = dominant contributor of the *first* position in the episode.
  const firstParts = contributions[fromIdx];
  const trigger    = triggerFromDominantFeature(firstParts);

  const pnlDuringEpisode = sum(members.map((p) => p.aggregatePnl ?? 0));

  return {
    id,
    startTime,
    endTime,
    trigger,
    positionIds: members.map((p) => p.id),
    severity: Math.min(1, severity),
    pnlDuringEpisode,
    pnlOutsideEpisodes: 0, // filled in by caller
  };
}

function triggerFromDominantFeature(parts: Record<string, number>): string {
  const entries = Object.entries(parts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0 || entries[0][1] <= 0) return 'behavioral_shift';
  const [feature] = entries[0];
  switch (feature) {
    case 'timeSinceLastLoss' : return 'large_loss';
    case 'recentLossCount'   : return 'consecutive_losses';
    case 'sizeVsAverage'     : return 'size_spike';
    case 'frequencyVsAverage': return 'frequency_spike';
    case 'holdTimeVsAverage' : return 'hold_time_collapse';
    case 'rollingPnl'        : return 'drawdown';
    default                  : return 'behavioral_shift';
  }
}

// ─── Small utilities ────────────────────────────────────────────────────────

function sortChronologically(positions: Position[]): Position[] {
  return [...positions]
    .filter((p) => p.firstEntryTime != null)
    .sort((a, b) => a.firstEntryTime!.getTime() - b.firstEntryTime!.getTime());
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function meanOfNonNull(xs: Array<number | null | undefined>): number {
  const vals = xs.filter((x): x is number => x != null && Number.isFinite(x));
  return vals.length === 0 ? 0 : sum(vals) / vals.length;
}

/** Mean seconds between consecutive trades in a slice. */
function meanGapSeconds(slice: Position[]): number {
  if (slice.length < 2) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    const prevExit = slice[i - 1].lastExitTime;
    const thisEntry = slice[i].firstEntryTime;
    if (prevExit && thisEntry) {
      const gap = (thisEntry.getTime() - prevExit.getTime()) / 1000;
      if (gap >= 0) gaps.push(gap);
    }
  }
  return gaps.length === 0 ? 0 : sum(gaps) / gaps.length;
}
