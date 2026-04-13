import { PacificaClient } from '../pacifica';
import { PacificaCandleSource } from '../regime/candle-sources/pacifica';
import { BybitCandleSource } from '../regime/candle-sources/bybit';
import { BinanceCandleSource } from '../regime/candle-sources/binance';
import { CandleCache, type CandleSourceAdapter } from './candle-cache';

/**
 * Pacifica-native assets that don't exist on Bybit or Binance under any
 * symbol mapping. Listed here so those adapters skip straight to the next
 * source instead of making doomed requests. Mirrors the list that used to
 * live in analytics/index.ts — moved here so every cache caller shares it.
 */
const PACIFICA_NATIVE_ONLY = new Set([
  'PIPPIN', 'FARTCOIN', 'PUMP', 'ASTER', 'WLFI', 'XPL',
  'BP', '2Z', 'MEGA', 'LIT', 'MON', 'PENGU',
  // kPEPE / kBONK use Pacifica's "k" (×1000) prefix that CEXes don't follow
  'kPEPE', 'kBONK',
  // Equity/commodity/forex perps — only on Pacifica
  'NVDA', 'TSLA', 'GOOGL', 'PLTR', 'HOOD', 'CRCL',
  'SP500', 'XAU', 'XAG', 'PLATINUM', 'COPPER', 'NATGAS', 'CL',
  'EURUSD', 'USDJPY', 'PAXG', 'URNM',
]);

function pacificaToSymbol(asset: string): string | null {
  return asset;
}

function ceXToUsdtSymbol(asset: string): string | null {
  if (PACIFICA_NATIVE_ONLY.has(asset)) return null;
  const base = asset.split('-')[0].toUpperCase();
  return `${base}USDT`;
}

/**
 * Process-wide CandleCache singleton. Instantiated lazily so module load
 * order doesn't matter and so scripts that don't need candles (e.g. the MCP
 * server) don't pay the Pacifica client setup cost.
 */
let _cache: CandleCache | null = null;

export function getCandleCache(): CandleCache {
  if (_cache) return _cache;
  const pacificaClient = new PacificaClient({
    apiConfigKey: process.env.PF_API_KEY,
  });
  const adapters: CandleSourceAdapter[] = [
    { name: 'pacifica', toSymbol: pacificaToSymbol, source: new PacificaCandleSource(pacificaClient.market) },
    { name: 'bybit',    toSymbol: ceXToUsdtSymbol,  source: new BybitCandleSource() },
    { name: 'binance',  toSymbol: ceXToUsdtSymbol,  source: new BinanceCandleSource() },
  ];
  _cache = new CandleCache(adapters);
  return _cache;
}

export { CandleCache, CacheBackedCandleSource, type CandleSourceAdapter, type DateRange } from './candle-cache';
