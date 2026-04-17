import { describe, it, expect } from 'vitest';
import {
  ScalpClassifier,
  DirectionalClassifier,
  ScaledDirectionalClassifier,
  CarryTradeClassifier,
} from '@/services/grouping/classifiers/position-classifier';
import type { Fill, OrderGroupData, PositionData } from '@/services/grouping/types';

function fill(over: Partial<Fill> & { id: string }): Fill {
  return {
    walletAddress: 'wallet',
    asset: 'SOL',
    direction: 'long',
    size: 1,
    entryPrice: 100,
    exitPrice: null,
    entryTime: null,
    exitTime: null,
    pnlRealized: null,
    fees: 0,
    fundingEarned: 0,
    fundingPaid: 0,
    holdTimeSeconds: null,
    rawData: null,
    builderCode: null,
    subaccount: null,
    cause: null,
    tradeType: null,
    regimeAtEntry: null,
    sentimentAtEntry: null,
    ...over,
  } as Fill;
}

function order(over: Partial<OrderGroupData> & { fills: Fill[] }): OrderGroupData {
  return {
    id: 'og1',
    asset: 'SOL',
    direction: 'long',
    fills: [],
    totalSize: 0,
    averageEntryPrice: 0,
    averageExitPrice: null,
    pnl: 0,
    fees: 0,
    funding: 0,
    status: 'closed',
    firstEntryTime: null,
    lastExitTime: null,
    tradeType: null,
    confidence: 1,
    ruleSource: 'fill-to-order',
    regimeAtEntry: null,
    sentimentAtEntry: null,
    ...over,
  } as OrderGroupData;
}

function position(over: Partial<PositionData>): PositionData {
  return {
    id: 'p1',
    asset: 'SOL',
    direction: 'long',
    orders: [],
    totalSize: 0,
    averageEntryPrice: 0,
    averageExitPrice: null,
    pnl: 0,
    fees: 0,
    funding: 0,
    status: 'closed',
    firstEntryTime: null,
    lastExitTime: null,
    holdTimeSeconds: null,
    tradeType: null,
    confidence: 1,
    regimeAtEntry: null,
    sentimentAtEntry: null,
    linkedStrategyId: null,
    ...over,
  } as PositionData;
}

describe('ScalpClassifier', () => {
  const classifier = new ScalpClassifier();

  it('short hold (< 15min) classifies as scalp with 0.85 confidence', () => {
    const result = classifier.classify(
      position({
        orders: [order({ fills: [fill({ id: 'f1' })] })],
        firstEntryTime: new Date('2025-01-01T00:00:00Z'),
        lastExitTime: new Date('2025-01-01T00:05:00Z'), // 5 min
      }),
    );
    expect(result).toEqual({ type: 'scalp', confidence: 0.85 });
  });

  it('hold >= 15min does not classify as scalp', () => {
    const result = classifier.classify(
      position({
        orders: [order({ fills: [fill({ id: 'f1' })] })],
        firstEntryTime: new Date('2025-01-01T00:00:00Z'),
        lastExitTime: new Date('2025-01-01T00:20:00Z'), // 20 min
      }),
    );
    expect(result).toBeNull();
  });

  it('positions with more than 3 orders are not scalps', () => {
    const result = classifier.classify(
      position({
        orders: [
          order({ id: 'og1', fills: [fill({ id: 'f1' })] }),
          order({ id: 'og2', fills: [fill({ id: 'f2' })] }),
          order({ id: 'og3', fills: [fill({ id: 'f3' })] }),
          order({ id: 'og4', fills: [fill({ id: 'f4' })] }),
        ],
        firstEntryTime: new Date('2025-01-01T00:00:00Z'),
        lastExitTime: new Date('2025-01-01T00:05:00Z'),
      }),
    );
    expect(result).toBeNull();
  });
});

describe('DirectionalClassifier (fallback)', () => {
  it('always returns directional with 0.5 confidence', () => {
    const result = new DirectionalClassifier().classify(position({}));
    expect(result).toEqual({ type: 'directional', confidence: 0.5 });
  });
});

describe('ScaledDirectionalClassifier', () => {
  const classifier = new ScaledDirectionalClassifier();

  it('2+ opens and 1+ closes across multiple orders classify as scaled_directional', () => {
    const result = classifier.classify(
      position({
        orders: [
          order({
            id: 'og1',
            fills: [
              fill({ id: 'f1', rawData: JSON.stringify({ side: 'open_long' }) }),
              fill({ id: 'f2', rawData: JSON.stringify({ side: 'open_long' }) }),
            ],
          }),
          order({
            id: 'og2',
            fills: [
              fill({ id: 'f3', rawData: JSON.stringify({ side: 'close_long' }) }),
            ],
          }),
        ],
      }),
    );
    expect(result).toEqual({ type: 'scaled_directional', confidence: 0.8 });
  });

  it('single order → not scaled', () => {
    const result = classifier.classify(
      position({
        orders: [
          order({
            fills: [fill({ id: 'f1', rawData: JSON.stringify({ side: 'open_long' }) })],
          }),
        ],
      }),
    );
    expect(result).toBeNull();
  });

  it('opens without any closes → not scaled', () => {
    const result = classifier.classify(
      position({
        orders: [
          order({ id: 'og1', fills: [fill({ id: 'f1', rawData: JSON.stringify({ side: 'open_long' }) })] }),
          order({ id: 'og2', fills: [fill({ id: 'f2', rawData: JSON.stringify({ side: 'open_long' }) })] }),
        ],
      }),
    );
    expect(result).toBeNull();
  });
});

describe('CarryTradeClassifier', () => {
  const classifier = new CarryTradeClassifier();

  it('short perp held > 24h with funding earned classifies as carry_trade (0.8)', () => {
    const result = classifier.classify(
      position({
        direction: 'short',
        firstEntryTime: new Date('2025-01-01T00:00:00Z'),
        lastExitTime: new Date('2025-01-02T06:00:00Z'), // 30 hours
        orders: [order({ fills: [fill({ id: 'f1', fundingEarned: 12.5 })] })],
      }),
    );
    expect(result).toEqual({ type: 'carry_trade', confidence: 0.8 });
  });

  it('long positions are never carry trades', () => {
    const result = classifier.classify(
      position({
        direction: 'long',
        firstEntryTime: new Date('2025-01-01T00:00:00Z'),
        lastExitTime: new Date('2025-01-03T00:00:00Z'),
        orders: [order({ fills: [fill({ id: 'f1', fundingEarned: 12.5 })] })],
      }),
    );
    expect(result).toBeNull();
  });

  it('short held < 24h is not a carry trade', () => {
    const result = classifier.classify(
      position({
        direction: 'short',
        firstEntryTime: new Date('2025-01-01T00:00:00Z'),
        lastExitTime: new Date('2025-01-01T10:00:00Z'),
        orders: [order({ fills: [fill({ id: 'f1', fundingEarned: 12.5 })] })],
      }),
    );
    expect(result).toBeNull();
  });

  it('short held > 48h with no funding still classifies (0.6)', () => {
    const result = classifier.classify(
      position({
        direction: 'short',
        firstEntryTime: new Date('2025-01-01T00:00:00Z'),
        lastExitTime: new Date('2025-01-04T00:00:00Z'),
        orders: [order({ fills: [fill({ id: 'f1' })] })],
      }),
    );
    expect(result).toEqual({ type: 'carry_trade', confidence: 0.6 });
  });
});
