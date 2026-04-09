/**
 * Rule 1 — Explicit Link (priority 10)
 *
 * Groups fills that share a known parent identifier:
 *   - order_id: Pacifica assigns the same order_id to all partial fills
 *     from a single order hitting multiple counterparties.
 *   - client_order_id: user-specified ID when attaching TP/SL to positions.
 *   - stop_parent_order_id: links TP/SL fills to the parent order (if present).
 *
 * All fills sharing a parent ID on the same asset = one group, confidence 1.0.
 *
 * This handles TWAP fills, scale orders, and any other case where the
 * exchange or our system explicitly links fills together.
 */

import type { Fill, GroupingRule, GroupingResult, ProposedGroup } from '../types';
import { parseRawData } from '../types';

export class ExplicitLinkRule implements GroupingRule {
  readonly name = 'explicit-link';
  readonly priority = 10;

  apply(fills: Fill[], _existingGroups: ProposedGroup[]): GroupingResult {
    // Build a map of link key → fills
    // A fill can belong to multiple link keys (order_id AND client_order_id),
    // but we use union-find to merge overlapping groups.
    const linkMap = new Map<string, Fill[]>();

    for (const fill of fills) {
      const raw = parseRawData(fill);
      const keys: string[] = [];

      if (raw.order_id != null) {
        keys.push(`order:${raw.order_id}`);
      }
      if (raw.client_order_id) {
        keys.push(`client:${raw.client_order_id}`);
      }
      // Future: stop_parent_order_id, parentGroupId, etc.
      const stopParent = (raw as Record<string, unknown>).stop_parent_order_id;
      if (stopParent != null) {
        keys.push(`stop_parent:${stopParent}`);
      }

      for (const key of keys) {
        if (!linkMap.has(key)) linkMap.set(key, []);
        linkMap.get(key)!.push(fill);
      }
    }

    // Only create groups from link keys that have multiple fills.
    // Single-fill link keys are just normal orders — not useful to group.
    const grouped = new Set<string>();
    const newGroups: ProposedGroup[] = [];

    for (const [, linkedFills] of linkMap) {
      if (linkedFills.length < 2) continue;

      // Skip fills already claimed by a previous link key in this pass
      const unclaimed = linkedFills.filter((f) => !grouped.has(f.id));
      if (unclaimed.length < 2) continue;

      for (const f of unclaimed) grouped.add(f.id);

      newGroups.push({
        fills: unclaimed,
        confidence: 1.0,
        ruleSource: this.name,
      });
    }

    const remainingFills = fills.filter((f) => !grouped.has(f.id));

    return { newGroups, remainingFills };
  }
}
