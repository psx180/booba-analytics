export interface Candle {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type RegimeClassification =
  | 'trending_low_vol'
  | 'trending_high_vol'
  | 'ranging_low_vol'
  | 'ranging_high_vol'
  | 'transitional';

export interface RegimeReading {
  timestamp: Date;
  classification: RegimeClassification;
  /** 0–1. How clearly this regime is established. ADX of 35 = high confidence; ADX of 22 = low. */
  confidence: number;
  /** Raw indicator values stored alongside the label — allows reclassification without refetching candles. */
  indicators: Record<string, number>;
}

export interface RegimeDetector {
  /** Stored in regime_snapshots.method so we know which algorithm produced each row. */
  readonly name: string;
  /** Minimum candles needed before the first valid reading (warmup period). */
  readonly requiredCandles: number;
  detect(candles: Candle[]): RegimeReading[];
}

export interface CandleSource {
  /** Identifies the data source in logs and for future filtering. */
  readonly name: string;
  fetchCandles(asset: string, timeframe: string, start: Date, end: Date): Promise<Candle[]>;
}
