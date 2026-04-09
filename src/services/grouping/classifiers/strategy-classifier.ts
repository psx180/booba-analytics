/**
 * Strategy-level classifiers.
 *
 * Classifies LinkedStrategies: delta_neutral, pairs_trade, basis_trade.
 * Since these are manually created, the user already specifies the type.
 * Classifiers here validate and assign confidence.
 */

import type { Classifier, ClassificationResult, LinkedStrategyData } from '../types';

export class DeltaNeutralValidator implements Classifier<LinkedStrategyData> {
  readonly name = 'delta-neutral';

  classify(strategy: LinkedStrategyData): ClassificationResult | null {
    if (strategy.strategyType !== 'delta_neutral') return null;

    const assets = [...new Set(strategy.legs.map((l) => l.asset))];
    const directions = [...new Set(strategy.legs.map((l) => l.direction))];

    if (assets.length === 1 && directions.length === 2) {
      // Check if notionals are roughly equal
      const longNotional = strategy.legs
        .filter((l) => l.direction === 'long')
        .reduce((s, l) => s + l.totalSize * l.averageEntryPrice, 0);
      const shortNotional = strategy.legs
        .filter((l) => l.direction === 'short')
        .reduce((s, l) => s + l.totalSize * l.averageEntryPrice, 0);

      const ratio = Math.min(longNotional, shortNotional) / Math.max(longNotional, shortNotional);
      const confidence = ratio > 0.9 ? 0.95 : ratio > 0.7 ? 0.8 : 0.6;
      return { type: 'delta_neutral', confidence };
    }
    return null;
  }
}

export class PairsTradeValidator implements Classifier<LinkedStrategyData> {
  readonly name = 'pairs-trade';

  classify(strategy: LinkedStrategyData): ClassificationResult | null {
    if (strategy.strategyType !== 'pairs_trade') return null;

    const assets = [...new Set(strategy.legs.map((l) => l.asset))];
    if (assets.length >= 2) {
      return { type: 'pairs_trade', confidence: 0.85 };
    }
    return null;
  }
}

export class BasisTradeValidator implements Classifier<LinkedStrategyData> {
  readonly name = 'basis-trade';

  classify(strategy: LinkedStrategyData): ClassificationResult | null {
    if (strategy.strategyType !== 'basis_trade') return null;
    return { type: 'basis_trade', confidence: 0.85 };
  }
}

export function createStrategyClassifiers(): Classifier<LinkedStrategyData>[] {
  return [
    new DeltaNeutralValidator(),
    new PairsTradeValidator(),
    new BasisTradeValidator(),
  ];
}
