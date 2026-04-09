import { ADX, ATR, SMA } from 'trading-signals';
import type { Candle, RegimeClassification, RegimeDetector, RegimeReading } from '../types';

export interface AdxAtrConfig {
  adxPeriod: number;
  atrPeriod: number;
  atrSmaPeriod: number;
  /**
   * ADX above this = trending.
   * Standard value is 25. Crypto may warrant tuning upward (30–35) since
   * crypto is structurally more volatile and ADX stays elevated more often,
   * potentially causing over-classification as trending.
   */
  trendingThreshold: number;
  /**
   * ADX below this = ranging.
   * Standard value is 20. Gap between rangingThreshold and trendingThreshold
   * defines the transitional zone.
   */
  rangingThreshold: number;
}

const DEFAULTS: AdxAtrConfig = {
  adxPeriod: 14,
  atrPeriod: 14,
  atrSmaPeriod: 20,
  trendingThreshold: 25,
  rangingThreshold: 20,
};

export class AdxAtrDetector implements RegimeDetector {
  readonly name = 'adx-atr';
  readonly requiredCandles: number;

  private config: AdxAtrConfig;

  constructor(config: Partial<AdxAtrConfig> = {}) {
    this.config = { ...DEFAULTS, ...config };
    // ADX needs ~2×period candles to warm up; add atrSmaPeriod on top for ATR SMA
    this.requiredCandles = this.config.adxPeriod * 2 + this.config.atrSmaPeriod;
  }

  detect(candles: Candle[]): RegimeReading[] {
    const { adxPeriod, atrPeriod, atrSmaPeriod, trendingThreshold, rangingThreshold } = this.config;

    const adxIndicator = new ADX(adxPeriod);
    const atrIndicator = new ATR(atrPeriod);
    const atrSma = new SMA(atrSmaPeriod);

    const readings: RegimeReading[] = [];

    for (const candle of candles) {
      const hlc = { high: candle.high, low: candle.low, close: candle.close };

      let adxVal: number | undefined;
      let atrVal: number | undefined;
      let atrSmaVal: number | undefined;

      try { adxVal = adxIndicator.update(hlc, false) as number; } catch { /* warming up */ }
      try { atrVal = atrIndicator.update(hlc, false) as number; } catch { /* warming up */ }
      if (atrVal !== undefined) {
        try { atrSmaVal = atrSma.update(atrVal, false) as number; } catch { /* warming up */ }
      }

      // Only emit a reading once all indicators have enough history
      if (adxVal === undefined || atrVal === undefined || atrSmaVal === undefined) continue;

      const classification = this.classify(adxVal, atrVal, atrSmaVal);
      const confidence = this.computeConfidence(adxVal);

      readings.push({
        timestamp: candle.timestamp,
        classification,
        confidence,
        indicators: {
          adx: adxVal,
          atr: atrVal,
          atr_sma: atrSmaVal,
        },
      });
    }

    return readings;
  }

  private classify(adx: number, atr: number, atrSma: number): RegimeClassification {
    const { trendingThreshold, rangingThreshold } = this.config;
    const isHighVol = atr > atrSma;

    if (adx >= trendingThreshold) {
      return isHighVol ? 'trending_high_vol' : 'trending_low_vol';
    }
    if (adx <= rangingThreshold) {
      return isHighVol ? 'ranging_high_vol' : 'ranging_low_vol';
    }
    return 'transitional';
  }

  /**
   * Confidence = how far ADX is from the ambiguous zone (20–25).
   * ADX ≥ 35 or ≤ 10 → 1.0. ADX in the 20–25 zone → near 0.
   * Scaled linearly from the nearest threshold outward, capped at 1.0.
   */
  private computeConfidence(adx: number): number {
    const { trendingThreshold, rangingThreshold } = this.config;
    const midpoint = (trendingThreshold + rangingThreshold) / 2;
    const halfZone = (trendingThreshold - rangingThreshold) / 2;
    // Max useful distance from midpoint for scaling (1.5× the ambiguous zone width)
    const maxDistance = halfZone + 15;
    const distance = Math.abs(adx - midpoint);
    const raw = (distance - halfZone) / maxDistance;
    return Math.min(1, Math.max(0, raw));
  }
}
