/**
 * Order-level classifiers.
 *
 * Classifies OrderGroups: partial_fill, twap, single.
 */

import type { Classifier, ClassificationResult, OrderGroupData } from '../types';

export class PartialFillClassifier implements Classifier<OrderGroupData> {
  readonly name = 'partial-fill';

  classify(order: OrderGroupData): ClassificationResult | null {
    if (order.fills.length >= 2) {
      return { type: 'partial_fill', confidence: 0.95 };
    }
    return null;
  }
}

export class TwapClassifier implements Classifier<OrderGroupData> {
  readonly name = 'twap';

  classify(order: OrderGroupData): ClassificationResult | null {
    if (order.fills.length < 3) return null;

    // TWAP: multiple fills at regular intervals with similar sizes
    const sizes = order.fills.map((f) => f.size);
    const avgSize = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    const sizeVariance = sizes.reduce((s, sz) => s + Math.pow(sz - avgSize, 2), 0) / sizes.length;
    const cv = Math.sqrt(sizeVariance) / avgSize; // coefficient of variation

    if (cv < 0.3 && order.fills.length >= 3) {
      return { type: 'twap', confidence: 0.8 };
    }
    return null;
  }
}

export class SingleOrderClassifier implements Classifier<OrderGroupData> {
  readonly name = 'single';

  classify(order: OrderGroupData): ClassificationResult | null {
    if (order.fills.length === 1) {
      return { type: 'single', confidence: 1.0 };
    }
    return null;
  }
}

export function createOrderClassifiers(): Classifier<OrderGroupData>[] {
  return [
    new TwapClassifier(),
    new PartialFillClassifier(),
    new SingleOrderClassifier(),
  ];
}
