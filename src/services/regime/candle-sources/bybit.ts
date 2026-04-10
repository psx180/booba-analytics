import type { Candle, CandleSource } from '../types';

const BYBIT_BASE = 'https://api.bybit.com/v5/market/kline';
const MAX_PER_REQUEST = 1000;

/**
 * Maps Binance-style interval notation to Bybit's format.
 * Bybit uses numeric minutes for sub-day intervals, then D/W/M.
 */
function toBybitInterval(interval: string): string {
  const map: Record<string, string> = {
    '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30',
    '1h': '60', '2h': '120', '4h': '240', '6h': '360', '12h': '720',
    '1d': 'D', '1w': 'W', '1M': 'M',
  };
  return map[interval] ?? interval;
}

/**
 * Fetches OHLCV candles from Bybit's public v5 klines endpoint.
 * No API key required. No US geo-restriction.
 *
 * Symbol format: Bybit linear perpetual notation, e.g. 'BTCUSDT'.
 * This matches the output of toBinanceSymbol() in analytics-service.ts,
 * so no additional symbol mapping is needed.
 */
export class BybitCandleSource implements CandleSource {
  readonly name = 'bybit';

  async fetchCandles(asset: string, timeframe: string, start: Date, end: Date): Promise<Candle[]> {
    const interval = toBybitInterval(timeframe);
    const allCandles: Candle[] = [];
    const startMs = start.getTime();
    let endCursor = end.getTime();

    while (endCursor > startMs) {
      const url = new URL(BYBIT_BASE);
      url.searchParams.set('category', 'linear');
      url.searchParams.set('symbol', asset);
      url.searchParams.set('interval', interval);
      url.searchParams.set('start', String(startMs));
      url.searchParams.set('end', String(endCursor));
      url.searchParams.set('limit', String(MAX_PER_REQUEST));

      const res = await fetch(url.toString());
      if (!res.ok) {
        throw new Error(`Bybit klines ${res.status}: ${await res.text()}`);
      }

      const data = await res.json() as {
        retCode: number;
        retMsg: string;
        result: { list: string[][] };
      };

      if (data.retCode !== 0) {
        throw new Error(`Bybit klines error ${data.retCode}: ${data.retMsg}`);
      }

      const raw = data.result.list; // newest first
      if (raw.length === 0) break;

      allCandles.push(...raw.map(parseBybitKline));

      if (raw.length < MAX_PER_REQUEST) break;
      // Paginate backwards: move end cursor to just before the oldest candle in this batch
      endCursor = Number(raw[raw.length - 1][0]) - 1;
    }

    // Sort chronologically (Bybit returns newest first)
    return allCandles.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }
}

/**
 * Bybit v5 kline list format (each entry is a string array):
 * [0] startTime (ms)
 * [1] openPrice
 * [2] highPrice
 * [3] lowPrice
 * [4] closePrice
 * [5] volume
 * [6] turnover
 */
function parseBybitKline(k: string[]): Candle {
  return {
    timestamp: new Date(Number(k[0])),
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  };
}
