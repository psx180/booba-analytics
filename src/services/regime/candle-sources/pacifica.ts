import type { CandleSource, Candle } from '../types';
import type { MarketAPI } from '../../pacifica/rest/market';
import type { CandleInterval } from '../../pacifica/types/market';

/**
 * Fetches candles from Pacifica's own kline endpoint.
 *
 * Asset format: Pacifica symbol notation, e.g. 'BTC' (not 'BTCUSDT').
 * Timeframe: matches Pacifica's interval notation — '1d', '1h', '4h', etc.
 *   Supported: '1m','3m','5m','15m','30m','1h','2h','4h','8h','12h','1d'
 *
 * NOTE ON DATA SOURCE:
 * These are Pacifica perpetual mark/index price candles — the same price
 * series that determines your PnL and liquidation on Pacifica. They will
 * match your trade entry/exit prices exactly. This makes them the most
 * accurate source for regime detection in the context of Pacifica trading.
 *
 * The trade-off vs Binance: Pacifica has less historical data than Binance
 * spot. If you need regime history that predates Pacifica's launch, use
 * BinanceCandleSource for the historical backfill and switch to this source
 * for ongoing regime detection.
 *
 * To swap in: pass a PacificaCandleSource to RegimeService instead of BinanceCandleSource.
 * No other changes required.
 */
export class PacificaCandleSource implements CandleSource {
  readonly name = 'pacifica';

  constructor(private market: MarketAPI) {}

  async fetchCandles(asset: string, timeframe: string, start: Date, end: Date): Promise<Candle[]> {
    const candles = await this.market.getCandles({
      symbol: asset,
      interval: timeframe as CandleInterval,
      startTime: start.getTime(),
      endTime: end.getTime(),
    });

    return candles.map((k) => ({
      timestamp: new Date(k.t),
      open:   parseFloat(k.o),
      high:   parseFloat(k.h),
      low:    parseFloat(k.l),
      close:  parseFloat(k.c),
      volume: parseFloat(k.v),
    }));
  }
}
