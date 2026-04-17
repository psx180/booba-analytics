import { describe, it, expect } from 'vitest';
import { AdxAtrDetector } from '@/services/regime/detectors/adx-atr';
import type { RegimeClassification } from '@/services/regime/types';

// classify(adx, atr, atrSma) is private; reach it through a typed alias so we
// can assert the classifier truth table without synthesising long candle
// series. The behaviour we're testing is the pure classification rule, which
// doesn't care about warm-up or indicator state.
type ClassifyFn = (adx: number, atr: number, atrSma: number) => RegimeClassification;

function classifyOf(detector: AdxAtrDetector): ClassifyFn {
  return (detector as unknown as { classify: ClassifyFn }).classify.bind(detector);
}

describe('AdxAtrDetector.classify (default thresholds 20 / 25)', () => {
  const classify = classifyOf(new AdxAtrDetector());

  it('high ADX + low ATR → trending_low_vol', () => {
    expect(classify(40, 5, 10)).toBe('trending_low_vol');
  });

  it('high ADX + high ATR → trending_high_vol', () => {
    expect(classify(40, 15, 10)).toBe('trending_high_vol');
  });

  it('low ADX + low ATR → ranging_low_vol', () => {
    expect(classify(10, 5, 10)).toBe('ranging_low_vol');
  });

  it('low ADX + high ATR → ranging_high_vol', () => {
    expect(classify(10, 15, 10)).toBe('ranging_high_vol');
  });

  it('ADX in (20, 25) gap → transitional', () => {
    expect(classify(22, 5, 10)).toBe('transitional');
    expect(classify(22, 15, 10)).toBe('transitional');
  });

  it('ADX exactly at the trending threshold (25) → trending', () => {
    expect(classify(25, 5, 10)).toBe('trending_low_vol');
    expect(classify(25, 15, 10)).toBe('trending_high_vol');
  });

  it('ADX exactly at the ranging threshold (20) → ranging', () => {
    expect(classify(20, 5, 10)).toBe('ranging_low_vol');
    expect(classify(20, 15, 10)).toBe('ranging_high_vol');
  });

  it('ATR equal to SMA is treated as low-vol (not strictly greater)', () => {
    expect(classify(40, 10, 10)).toBe('trending_low_vol');
    expect(classify(10, 10, 10)).toBe('ranging_low_vol');
  });

  it('honours custom thresholds in config', () => {
    const custom = classifyOf(
      new AdxAtrDetector({ rangingThreshold: 15, trendingThreshold: 30 }),
    );
    expect(custom(25, 5, 10)).toBe('transitional');
    expect(custom(30, 5, 10)).toBe('trending_low_vol');
    expect(custom(15, 5, 10)).toBe('ranging_low_vol');
  });
});

describe('AdxAtrDetector.detect', () => {
  it('returns no readings when fed fewer candles than required', () => {
    const detector = new AdxAtrDetector();
    const readings = detector.detect([]);
    expect(readings).toEqual([]);
  });

  it('exposes the configured warm-up length via requiredCandles', () => {
    const detector = new AdxAtrDetector();
    // adxPeriod*2 + atrSmaPeriod = 14*2 + 20 = 48
    expect(detector.requiredCandles).toBe(48);
  });
});
