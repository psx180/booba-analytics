import { z } from 'zod';

// ─── Market Info (/api/v1/info) ───────────────────────────────────────────────

export const MarketInfoSchema = z.object({
  symbol: z.string(),
  tick_size: z.string(),
  min_tick: z.string(),
  max_tick: z.string(),
  lot_size: z.string(),
  min_order_size: z.string(),
  max_order_size: z.string(),
  max_leverage: z.number(),
  isolated_only: z.boolean(),
  funding_rate: z.string(),
  estimated_funding_rate: z.string(),
  created_at: z.number(),
});
export type MarketInfo = z.infer<typeof MarketInfoSchema>;

// ─── Prices (/api/v1/info/prices) ────────────────────────────────────────────

export const PriceSchema = z.object({
  symbol: z.string(),
  mark: z.string(),
  oracle: z.string(),
  mid: z.string(),
  funding: z.string(),
  next_funding: z.string(),
  open_interest: z.string(),
  volume_24h: z.string(),
  yesterday_price: z.string(),
  timestamp: z.number(),
});
export type Price = z.infer<typeof PriceSchema>;

// ─── Orderbook (/api/v1/book) ─────────────────────────────────────────────────

export const OrderbookLevelSchema = z.object({
  p: z.string(), // price
  a: z.string(), // amount
  n: z.number(), // order count
});

export const OrderbookSchema = z.object({
  s: z.string(),  // symbol
  l: z.tuple([
    z.array(OrderbookLevelSchema), // bids [0]
    z.array(OrderbookLevelSchema), // asks [1]
  ]),
  t: z.number(),  // timestamp
});
export type Orderbook = z.infer<typeof OrderbookSchema>;

// ─── Candles (/api/v1/kline) ──────────────────────────────────────────────────

export const CandleSchema = z.object({
  t: z.number(),  // open time
  T: z.number(),  // close time
  s: z.string(),  // symbol
  i: z.string(),  // interval
  o: z.string(),  // open
  c: z.string(),  // close
  h: z.string(),  // high
  l: z.string(),  // low
  v: z.string(),  // volume
  n: z.number(),  // trade count
});
export type Candle = z.infer<typeof CandleSchema>;

export type CandleInterval =
  | '1m' | '3m' | '5m' | '15m' | '30m'
  | '1h' | '2h' | '4h' | '8h' | '12h'
  | '1d';

// ─── Recent Market Trades (/api/v1/trades) ────────────────────────────────────

export const MarketTradeSchema = z.object({
  event_type: z.enum(['fulfill_taker', 'fulfill_maker']),
  price: z.string(),
  amount: z.string(),
  side: z.enum(['open_long', 'open_short', 'close_long', 'close_short']),
  cause: z.enum(['normal', 'market_liquidation', 'backstop_liquidation', 'settlement']),
  created_at: z.number(),
  last_order_id: z.number().optional(),
});
export type MarketTrade = z.infer<typeof MarketTradeSchema>;

// ─── Historical Funding Rates (/api/v1/funding_rate/history) ─────────────────

export const FundingRateHistorySchema = z.object({
  oracle_price: z.string(),
  bid_impact_price: z.string(),
  ask_impact_price: z.string(),
  funding_rate: z.string(),
  next_funding_rate: z.string(),
  created_at: z.number(),
});
export type FundingRateHistory = z.infer<typeof FundingRateHistorySchema>;