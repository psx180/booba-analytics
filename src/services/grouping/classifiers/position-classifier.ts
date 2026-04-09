/**
 * Position-level classifiers.
 *
 * Classifies Positions: scalp, directional, scaled_directional,
 * carry_trade, market_making.
 *
 * Each classifier is independent — returns result or null.
 * The service picks the highest-confidence match.
 */

import type { Classifier, ClassificationResult, PositionData } from '../types';
import { parseRawData } from '../types';

export class MarketMakingClassifier implements Classifier<PositionData> {
  readonly name = 'market-making';

  classify(position: PositionData): ClassificationResult | null {
    const allFills = position.orders.flatMap((o) => o.fills);
    if (allFills.length < 4) return null;

    // Check for builder code (strong signal)
    const hasBuilder = allFills.some((f) => f.builderCode);

    // Check for rapid alternating buy/sell pattern
    const sorted = [...allFills].sort((a, b) => {
      const ta = (a.entryTime ?? a.exitTime ?? new Date(0)).getTime();
      const tb = (b.entryTime ?? b.exitTime ?? new Date(0)).getTime();
      return ta - tb;
    });

    let alternations = 0;
    for (let i = 1; i < sorted.length; i++) {
      const prevSide = getSide(sorted[i - 1]);
      const currSide = getSide(sorted[i]);
      if (prevSide && currSide && prevSide !== currSide) {
        alternations++;
      }
    }

    const alternationRatio = alternations / (sorted.length - 1);

    if (hasBuilder && alternationRatio > 0.4) {
      return { type: 'market_making', confidence: 0.9 };
    }
    if (alternationRatio > 0.6 && allFills.length >= 8) {
      return { type: 'market_making', confidence: 0.75 };
    }
    return null;
  }
}

export class ScalpClassifier implements Classifier<PositionData> {
  readonly name = 'scalp';

  classify(position: PositionData): ClassificationResult | null {
    if (position.orders.length > 3) return null;

    const holdMs = positionHoldMs(position);
    if (holdMs === null) return null;

    // Under 15 minutes = scalp
    if (holdMs < 15 * 60 * 1000) {
      return { type: 'scalp', confidence: 0.85 };
    }
    return null;
  }
}

export class ScaledDirectionalClassifier implements Classifier<PositionData> {
  readonly name = 'scaled-directional';

  classify(position: PositionData): ClassificationResult | null {
    if (position.orders.length < 2) return null;

    const allFills = position.orders.flatMap((o) => o.fills);
    let opens = 0;
    let closes = 0;
    for (const fill of allFills) {
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

export class CarryTradeClassifier implements Classifier<PositionData> {
  readonly name = 'carry-trade';

  classify(position: PositionData): ClassificationResult | null {
    // Short perp held > 24 hours
    if (position.direction !== 'short') return null;

    const holdMs = positionHoldMs(position);
    if (holdMs === null || holdMs < 24 * 60 * 60 * 1000) return null;

    const allFills = position.orders.flatMap((o) => o.fills);
    const hasFunding = allFills.some((f) => (f.fundingEarned ?? 0) > 0);

    if (hasFunding) {
      return { type: 'carry_trade', confidence: 0.8 };
    }
    if (holdMs > 48 * 60 * 60 * 1000) {
      return { type: 'carry_trade', confidence: 0.6 };
    }
    return null;
  }
}

export class DirectionalClassifier implements Classifier<PositionData> {
  readonly name = 'directional';

  classify(_position: PositionData): ClassificationResult | null {
    return { type: 'directional', confidence: 0.5 };
  }
}

export function createPositionClassifiers(): Classifier<PositionData>[] {
  return [
    new MarketMakingClassifier(),
    new ScalpClassifier(),
    new ScaledDirectionalClassifier(),
    new CarryTradeClassifier(),
    new DirectionalClassifier(), // fallback
  ];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getSide(fill: { rawData: string | null }): string | null {
  if (!fill.rawData) return null;
  try {
    const raw = JSON.parse(fill.rawData);
    return raw.side ?? null;
  } catch {
    return null;
  }
}

function positionHoldMs(position: PositionData): number | null {
  if (!position.firstEntryTime || !position.lastExitTime) return null;
  return position.lastExitTime.getTime() - position.firstEntryTime.getTime();
}
