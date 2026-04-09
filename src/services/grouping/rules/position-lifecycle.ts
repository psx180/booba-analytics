/**
 * Rule 3 — Position Lifecycle (priority 30)
 *
 * The most important grouping rule. Tracks net position per asset per
 * subaccount over time, ordered chronologically:
 *
 *   - Start at 0
 *   - Each open fill increases position, each close fill decreases
 *   - When position returns to 0, everything from the opening fill to
 *     the closing fill is one group
 *   - Handles partial closes: buy 10, sell 5, sell 5 → one group
 *   - Handles scaling: buy 5, buy 3, buy 2, sell 10 → one group
 *   - Still-open positions get a group with status implied by non-zero net
 *
 * Edge case handling: when net position hits zero and the next fill on the
 * same asset arrives after the configured gap threshold, it starts a NEW
 * group. This prevents "close position, immediately reopen" from merging
 * into a single group.
 *
 * Confidence: 0.85.
 */

import type { Fill, GroupingRule, GroupingResult, ProposedGroup } from '../types';
import { parseRawData } from '../types';

export interface PositionLifecycleConfig {
  /**
   * After net position hits zero, if the next fill on the same asset
   * arrives more than this many ms later, it starts a new group.
   * Default: 30 seconds.
   */
  reopenGapMs: number;
}

const DEFAULT_CONFIG: PositionLifecycleConfig = {
  reopenGapMs: 30_000,
};

export class PositionLifecycleRule implements GroupingRule {
  readonly name = 'position-lifecycle';
  readonly priority = 30;
  private config: PositionLifecycleConfig;

  constructor(config: Partial<PositionLifecycleConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  apply(fills: Fill[], _existingGroups: ProposedGroup[]): GroupingResult {
    // Sort all fills chronologically
    const sorted = [...fills].sort((a, b) => {
      const ta = this.fillTime(a);
      const tb = this.fillTime(b);
      return ta - tb;
    });

    // Track position per asset:subaccount
    const trackers = new Map<string, PositionTracker>();
    const grouped = new Set<string>();
    const newGroups: ProposedGroup[] = [];

    for (const fill of sorted) {
      const sub = fill.subaccount ?? 'default';
      const key = `${fill.asset}:${sub}`;

      if (!trackers.has(key)) {
        trackers.set(key, new PositionTracker(this.config.reopenGapMs));
      }

      const tracker = trackers.get(key)!;
      const raw = parseRawData(fill);
      const isClose = raw.side?.startsWith('close_') ?? false;
      const size = fill.size;
      const time = this.fillTime(fill);

      const completedGroup = tracker.addFill(fill, size, isClose, time);

      if (completedGroup) {
        // A complete open→close cycle was detected
        for (const f of completedGroup) grouped.add(f.id);
        newGroups.push({
          fills: completedGroup,
          confidence: 0.85,
          ruleSource: this.name,
        });
      }
    }

    // Flush any still-open positions as open groups
    for (const tracker of trackers.values()) {
      const openFills = tracker.flush();
      if (openFills.length > 0) {
        for (const f of openFills) grouped.add(f.id);
        newGroups.push({
          fills: openFills,
          confidence: 0.85,
          ruleSource: this.name,
        });
      }
    }

    const remainingFills = fills.filter((f) => !grouped.has(f.id));
    return { newGroups, remainingFills };
  }

  private fillTime(fill: Fill): number {
    return (fill.entryTime ?? fill.exitTime ?? new Date(0)).getTime();
  }
}

/**
 * Tracks net position for a single asset:subaccount pair.
 * Accumulates fills into the current group. When net position returns to
 * zero, emits the completed group. Implements the gap detection for the
 * close-then-reopen edge case.
 */
class PositionTracker {
  private netPosition = 0;
  private currentFills: Fill[] = [];
  private lastZeroTime: number | null = null;
  private reopenGapMs: number;

  constructor(reopenGapMs: number) {
    this.reopenGapMs = reopenGapMs;
  }

  /**
   * Add a fill to the tracker.
   * Returns the completed group if net position just hit zero, or null.
   */
  addFill(fill: Fill, size: number, isClose: boolean, timeMs: number): Fill[] | null {
    // Check gap: if we were at zero and enough time has passed, this fill
    // starts a fresh group regardless of what happened before.
    if (this.netPosition === 0 && this.currentFills.length > 0) {
      // Position was at zero with accumulated fills — that means we already
      // emitted a completed group, so currentFills should be empty.
      // But if there are lingering fills, this is the gap detection path.
    }

    // If position is at zero and this is a new fill after a gap, ensure
    // we're starting fresh.
    if (this.netPosition === 0 && this.lastZeroTime !== null) {
      const gap = timeMs - this.lastZeroTime;
      if (gap > this.reopenGapMs) {
        // Gap exceeded — any leftover fills were already emitted.
        // Reset state for the new position.
        this.currentFills = [];
        this.lastZeroTime = null;
      }
    }

    // Add fill to current group
    this.currentFills.push(fill);

    // Update net position
    if (isClose) {
      this.netPosition -= size;
    } else {
      this.netPosition += size;
    }

    // Snap to zero for floating point dust
    if (Math.abs(this.netPosition) < 1e-10) {
      this.netPosition = 0;
      this.lastZeroTime = timeMs;

      // Position closed — emit the completed group
      const completed = this.currentFills;
      this.currentFills = [];
      return completed;
    }

    return null;
  }

  /** Flush any remaining fills (open positions). */
  flush(): Fill[] {
    const remaining = this.currentFills;
    this.currentFills = [];
    this.netPosition = 0;
    this.lastZeroTime = null;
    return remaining;
  }
}
