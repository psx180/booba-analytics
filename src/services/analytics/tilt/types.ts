/**
 * Tilt detection types.
 *
 * A tilt detector consumes chronologically-ordered positions and produces:
 *   - a TiltScore per position (0-1 likelihood the position is "tilted")
 *   - TiltEpisodes: contiguous runs of positions that together form a
 *     behavioural deviation from baseline.
 *
 * The interface is deliberately minimal so implementations can range from
 * hand-tuned heuristics to statistical change-point detection to future
 * ML models — callers only care about the output shape.
 */

import type { Position } from '../types';

export interface TiltFeatures {
  /** Seconds since the previous position closed at a loss; null if n/a. */
  timeSinceLastLoss: number | null;
  /** Number of losses in the last N trades (spec: last 5). */
  recentLossCount: number;
  /** Ratio of this position's size to rolling-baseline size. */
  sizeVsAverage: number;
  /** Ratio of recent trade frequency to baseline frequency. */
  frequencyVsAverage: number;
  /** Ratio of this position's hold time to baseline hold time. */
  holdTimeVsAverage: number;
  /** P&L over the last N trades (spec: last 5). */
  rollingPnl: number;
}

export interface TiltScore {
  positionId: string;
  /** 0-1; higher = more likely tilted. */
  score: number;
  features: TiltFeatures;
  /** Non-null if this position is part of a detected episode. */
  episodeId: string | null;
}

export interface TiltEpisode {
  id: string;
  startTime: Date;
  /** Null if the episode is ongoing (final position is the most recent). */
  endTime: Date | null;
  /** What started it: 'consecutive_losses' | 'large_loss' | 'drawdown' | 'size_spike' | 'frequency_spike' | 'hold_time_collapse' | 'behavioral_shift'. */
  trigger: string;
  positionIds: string[];
  /** 0-1; peak intensity within the episode. */
  severity: number;
  /** Total P&L realised during this episode. */
  pnlDuringEpisode: number;
  /** Total P&L realised outside any episode, for comparison. */
  pnlOutsideEpisodes: number;
}

export interface TiltDetectionResult {
  scores: TiltScore[];
  episodes: TiltEpisode[];
}

export interface TiltDetector {
  /** Unique name for logging and registration. */
  name: string;
  /**
   * Run detection over the full position history. Implementations must be
   * pure — no I/O, no side effects. The caller is responsible for sorting
   * chronologically if the algorithm requires it, but a well-behaved
   * detector sorts internally to be safe.
   */
  detect(positions: Position[]): TiltDetectionResult;
}
