/**
 * Rule 4 — Time Proximity (priority 40)
 *
 * Fallback rule for fills that weren't caught by earlier rules.
 * Groups fills on the same asset + direction that occur within a
 * configurable time window of each other.
 *
 * Confidence: 0.6 — these are best-effort groupings that may need
 * user review.
 */

import type { Fill, GroupingRule, GroupingResult, ProposedGroup } from '../types';

export interface TimeProximityConfig {
  /** Max gap between consecutive fills to stay in the same group (ms). Default: 5 minutes. */
  windowMs: number;
}

const DEFAULT_CONFIG: TimeProximityConfig = {
  windowMs: 5 * 60 * 1000, // 5 minutes
};

export class TimeProximityRule implements GroupingRule {
  readonly name = 'time-proximity';
  readonly priority = 40;
  private config: TimeProximityConfig;

  constructor(config: Partial<TimeProximityConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  apply(fills: Fill[], _existingGroups: ProposedGroup[]): GroupingResult {
    if (fills.length === 0) {
      return { newGroups: [], remainingFills: [] };
    }

    // Bucket by asset + direction
    const buckets = new Map<string, Fill[]>();
    for (const fill of fills) {
      const key = `${fill.asset}:${fill.direction}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(fill);
    }

    const newGroups: ProposedGroup[] = [];
    const grouped = new Set<string>();

    for (const [, bucketFills] of buckets) {
      // Sort by time
      const sorted = [...bucketFills].sort((a, b) => {
        const ta = this.fillTime(a);
        const tb = this.fillTime(b);
        return ta - tb;
      });

      // Cluster by time proximity
      let cluster: Fill[] = [sorted[0]];

      for (let i = 1; i < sorted.length; i++) {
        const prevTime = this.fillTime(cluster[cluster.length - 1]);
        const currTime = this.fillTime(sorted[i]);

        if (currTime - prevTime > this.config.windowMs) {
          // Gap exceeded — flush current cluster
          this.emitGroup(cluster, newGroups, grouped);
          cluster = [];
        }
        cluster.push(sorted[i]);
      }

      // Flush final cluster
      this.emitGroup(cluster, newGroups, grouped);
    }

    const remainingFills = fills.filter((f) => !grouped.has(f.id));
    return { newGroups, remainingFills };
  }

  private emitGroup(cluster: Fill[], groups: ProposedGroup[], grouped: Set<string>) {
    if (cluster.length === 0) return;

    for (const f of cluster) grouped.add(f.id);
    groups.push({
      fills: cluster,
      confidence: 0.6,
      ruleSource: this.name,
    });
  }

  private fillTime(fill: Fill): number {
    return (fill.entryTime ?? fill.exitTime ?? new Date(0)).getTime();
  }
}
