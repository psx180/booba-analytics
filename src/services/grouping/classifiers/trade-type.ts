/**
 * classifiers/trade-type.ts
 *
 * Classifies a ProposedGroup into a trade type based on fill patterns.
 * Each classifier is independent — returns a result or null.
 * The service picks the highest-confidence match.
 */

import type { ProposedGroup, GroupClassifier, ClassificationResult, Fill } from '../types';
import { parseRawData } from '../types';

// ─── Market Making ──────────────────────────────────────────────────────────

export class MarketMakingClassifier implements GroupClassifier {
  readonly name = 'market-making';

  classify(group: ProposedGroup): ClassificationResult | null {
    if (group.fills.length < 4) return null;

    // Check for rapid alternating buy/sell pattern
    const sorted = sortByTime(group.fills);
    let alternations = 0;
    for (let i = 1; i < sorted.length; i++) {
      const prevSide = getSide(sorted[i - 1]);
      const currSide = getSide(sorted[i]);
      if (prevSide && currSide && prevSide !== currSide) {
        alternations++;
      }
    }

    const alternationRatio = alternations / (sorted.length - 1);

    // Also check if builder code is present (strong signal)
    const hasBuilder = group.fills.some((f) => f.builderCode);

    if (hasBuilder && alternationRatio > 0.4) {
      return { type: 'market_making', confidence: 0.9 };
    }
    if (alternationRatio > 0.6) {
      return { type: 'market_making', confidence: 0.75 };
    }
    return null;
  }
}

// ─── Scalp ──────────────────────────────────────────────────────────────────

export class ScalpClassifier implements GroupClassifier {
  readonly name = 'scalp';

  classify(group: ProposedGroup): ClassificationResult | null {
    if (group.fills.length > 3) return null;

    const holdMs = groupHoldTimeMs(group.fills);
    if (holdMs === null) return null;

    // Under 15 minutes = scalp
    if (holdMs < 15 * 60 * 1000) {
      return { type: 'scalp', confidence: 0.85 };
    }
    return null;
  }
}

// ─── Scaled Directional ─────────────────────────────────────────────────────

export class ScaledDirectionalClassifier implements GroupClassifier {
  readonly name = 'scaled-directional';

  classify(group: ProposedGroup): ClassificationResult | null {
    if (group.fills.length < 3) return null;

    // Count opens and closes
    let opens = 0;
    let closes = 0;
    for (const fill of group.fills) {
      const raw = parseRawData(fill);
      const side = raw.side ?? '';
      if (side.startsWith('open_')) opens++;
      else if (side.startsWith('close_')) closes++;
    }

    // Multiple entries then close(s) = scaled directional
    if (opens >= 2 && closes >= 1) {
      return { type: 'scaled_directional', confidence: 0.8 };
    }
    return null;
  }
}

// ─── Delta Neutral ──────────────────────────────────────────────────────────

export class DeltaNeutralClassifier implements GroupClassifier {
  readonly name = 'delta-neutral';

  classify(group: ProposedGroup): ClassificationResult | null {
    // Look for both long and short fills on the same asset with overlapping time
    const hasLong = group.fills.some((f) => f.direction === 'long');
    const hasShort = group.fills.some((f) => f.direction === 'short');

    if (hasLong && hasShort) {
      // Check if notionals are roughly equal
      const longSize = group.fills
        .filter((f) => f.direction === 'long')
        .reduce((s, f) => s + f.size * f.entryPrice, 0);
      const shortSize = group.fills
        .filter((f) => f.direction === 'short')
        .reduce((s, f) => s + f.size * f.entryPrice, 0);

      const ratio = Math.min(longSize, shortSize) / Math.max(longSize, shortSize);
      if (ratio > 0.8) {
        return { type: 'delta_neutral', confidence: 0.85 };
      }
    }
    return null;
  }
}

// ─── Carry Trade ────────────────────────────────────────────────────────────

export class CarryTradeClassifier implements GroupClassifier {
  readonly name = 'carry-trade';

  classify(group: ProposedGroup): ClassificationResult | null {
    // Short perp held > 24 hours with funding received
    const allShort = group.fills.every((f) => f.direction === 'short');
    if (!allShort) return null;

    const holdMs = groupHoldTimeMs(group.fills);
    if (holdMs === null || holdMs < 24 * 60 * 60 * 1000) return null;

    const hasFunding = group.fills.some(
      (f) => (f.fundingEarned ?? 0) > 0,
    );

    if (hasFunding) {
      return { type: 'carry_trade', confidence: 0.8 };
    }
    // Long hold short position even without funding data — still likely carry
    if (holdMs > 48 * 60 * 60 * 1000) {
      return { type: 'carry_trade', confidence: 0.6 };
    }
    return null;
  }
}

// ─── Directional (default fallback) ─────────────────────────────────────────

export class DirectionalClassifier implements GroupClassifier {
  readonly name = 'directional';

  classify(_group: ProposedGroup): ClassificationResult | null {
    // Always matches as the lowest-confidence fallback
    return { type: 'directional', confidence: 0.5 };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sortByTime(fills: Fill[]): Fill[] {
  return [...fills].sort((a, b) => {
    const ta = (a.entryTime ?? a.exitTime ?? new Date(0)).getTime();
    const tb = (b.entryTime ?? b.exitTime ?? new Date(0)).getTime();
    return ta - tb;
  });
}

function getSide(fill: Fill): string | null {
  const raw = parseRawData(fill);
  return raw.side ?? null;
}

function groupHoldTimeMs(fills: Fill[]): number | null {
  const times = fills
    .flatMap((f) => [f.entryTime, f.exitTime])
    .filter((t): t is Date => t != null)
    .map((t) => t.getTime());

  if (times.length < 2) return null;
  return Math.max(...times) - Math.min(...times);
}
