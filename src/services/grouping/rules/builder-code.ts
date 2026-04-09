/**
 * Rule 2 — Builder Code (priority 20)
 *
 * Groups fills that share the same builder code on the same asset within
 * a continuous time session. A session breaks when the gap between
 * consecutive fills exceeds the configured threshold.
 *
 * Confidence: 0.95. These are third-party bot fills (Treadfi, etc.).
 *
 * Note: builder code is one signal for the classifier, NOT a direct
 * mapping to trade type. A treadfi session could be market making or
 * a directional scale-in — the classifier decides based on fill patterns.
 */

import type { Fill, GroupingRule, GroupingResult, ProposedGroup } from '../types';

export interface BuilderCodeConfig {
  /** Max gap between consecutive fills in a session (ms). Default: 1 hour. */
  sessionGapMs: number;
}

const DEFAULT_CONFIG: BuilderCodeConfig = {
  sessionGapMs: 60 * 60 * 1000, // 1 hour
};

export class BuilderCodeRule implements GroupingRule {
  readonly name = 'builder-code';
  readonly priority = 20;
  private config: BuilderCodeConfig;

  constructor(config: Partial<BuilderCodeConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  apply(fills: Fill[], _existingGroups: ProposedGroup[]): GroupingResult {
    // Partition fills by builder code presence
    const withBuilder: Fill[] = [];
    const withoutBuilder: Fill[] = [];

    for (const fill of fills) {
      if (fill.builderCode) {
        withBuilder.push(fill);
      } else {
        withoutBuilder.push(fill);
      }
    }

    if (withBuilder.length === 0) {
      return { newGroups: [], remainingFills: fills };
    }

    // Group by builderCode + asset, then split by session gaps
    const buckets = new Map<string, Fill[]>();
    for (const fill of withBuilder) {
      const key = `${fill.builderCode}:${fill.asset}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(fill);
    }

    const newGroups: ProposedGroup[] = [];

    for (const [, bucketFills] of buckets) {
      // Sort by time
      const sorted = [...bucketFills].sort((a, b) => {
        const ta = (a.entryTime ?? a.exitTime)?.getTime() ?? 0;
        const tb = (b.entryTime ?? b.exitTime)?.getTime() ?? 0;
        return ta - tb;
      });

      // Split into sessions by gap threshold
      let session: Fill[] = [sorted[0]];

      for (let i = 1; i < sorted.length; i++) {
        const prevTime = (session[session.length - 1].entryTime ?? session[session.length - 1].exitTime)?.getTime() ?? 0;
        const currTime = (sorted[i].entryTime ?? sorted[i].exitTime)?.getTime() ?? 0;

        if (currTime - prevTime > this.config.sessionGapMs) {
          // Gap exceeded — flush current session
          if (session.length > 0) {
            newGroups.push({
              fills: session,
              confidence: 0.95,
              ruleSource: this.name,
            });
          }
          session = [];
        }
        session.push(sorted[i]);
      }

      // Flush final session
      if (session.length > 0) {
        newGroups.push({
          fills: session,
          confidence: 0.95,
          ruleSource: this.name,
        });
      }
    }

    return { newGroups, remainingFills: withoutBuilder };
  }
}
