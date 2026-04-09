import type { Candle, CandleSource } from '../types';

const BINANCE_BASE = 'https://api.binance.com/api/v3/klines';
const MAX_PER_REQUEST = 1000;

/**
 * Fetches OHLCV candles from Binance's public klines endpoint.
 * No API key required.
 *
 * Asset format: Binance pair notation, e.g. 'BTCUSDT'.
 * Timeframe: Binance interval notation, e.g. '1d', '1h', '4h'.
 *
 * NOTE ON DATA SOURCE:
 * These are Binance spot price candles. Pacifica trades against perpetual
 * mark/index prices, which can diverge from Binance spot during high funding
 * or liquidation cascades. For daily regime detection this difference is
 * minor — BTC spot and perp track closely on a daily timeframe. For intraday
 * regime detection (hourly or lower), consider switching to PacificaCandleSource
 * to use the actual prices your trades executed against.
 */
export class BinanceCandleSource implements CandleSource {
  readonly name = 'binance';

  async fetchCandles(asset: string, timeframe: string, start: Date, end: Date): Promise<Candle[]> {
    const allCandles: Candle[] = [];
    let cursor = start.getTime();
    const endMs = end.getTime();

    while (cursor < endMs) {
      const url = new URL(BINANCE_BASE);
      url.searchParams.set('symbol', asset);
      url.searchParams.set('interval', timeframe);
      url.searchParams.set('startTime', String(cursor));
      url.searchParams.set('endTime', String(endMs));
      url.searchParams.set('limit', String(MAX_PER_REQUEST));

      const res = await fetch(url.toString());
      if (!res.ok) {
        throw new Error(`Binance klines ${res.status}: ${await res.text()}`);
      }

      const raw = await res.json() as unknown[][];
      if (raw.length === 0) break;

      const candles = raw.map(parseBinanceKline);
      allCandles.push(...candles);

      if (raw.length < MAX_PER_REQUEST) break;
      // Advance cursor past the last returned candle's open time
      cursor = Number(raw[raw.length - 1][0]) + 1;
    }

    return allCandles;
  }
}

/**
 * Binance kline array format:
 * [0]  Open time (ms)
 * [1]  Open
 * [2]  High
 * [3]  Low
 * [4]  Close
 * [5]  Volume
 * [6]  Close time (ms)
 * ... (additional fields ignored)
 */
function parseBinanceKline(k: unknown[]): Candle {
  return {
    timestamp: new Date(Number(k[0])),
    open:   parseFloat(k[1] as string),
    high:   parseFloat(k[2] as string),
    low:    parseFloat(k[3] as string),
    close:  parseFloat(k[4] as string),
    volume: parseFloat(k[5] as string),
  };
}
