import { z } from 'zod';

// ─── Outbound (client → server) ───────────────────────────────────────────────

export interface WsSubscribeMessage {
  method: 'subscribe' | 'unsubscribe';
  params: WsSubscribeParams;
}

export interface WsActionMessage {
  id: string;
  params: Record<string, unknown>;
}

// Subscription params by channel
export type WsSubscribeParams =
  | { source: 'prices' }
  | { source: 'orderbook'; symbol: string; agg_level?: number }
  | { source: 'bbo'; symbol: string }
  | { source: 'trades'; symbol: string }
  | { source: 'candle'; symbol: string; interval: string }
  | { source: 'mark_price_candle'; symbol: string; interval: string }
  | { source: 'account_margin'; account: string }
  | { source: 'account_leverage'; account: string }
  | { source: 'account_info'; account: string }
  | { source: 'account_positions'; account: string }
  | { source: 'account_order_updates'; account: string }
  | { source: 'account_trades'; account: string }
  | { source: 'account_twap_orders'; account: string }
  | { source: 'account_twap_order_updates'; account: string };

// ─── Inbound (server → client) ────────────────────────────────────────────────

export const WsPriceUpdateSchema = z.object({
  source: z.literal('prices'),
  data: z.array(z.object({
    symbol: z.string(),
    mark: z.string(),
    oracle: z.string(),
    mid: z.string().optional(),
    funding: z.string(),
    next_funding: z.string(),
    open_interest: z.string(),
    timestamp: z.number(),
  })),
});
export type WsPriceUpdate = z.infer<typeof WsPriceUpdateSchema>;

export const WsAccountInfoUpdateSchema = z.object({
  source: z.literal('account_info'),
  data: z.object({
    account_equity: z.string().optional(),
    balance: z.string().optional(),
    total_margin_used: z.string().optional(),
    cross_mmr: z.string().optional(),
    positions_count: z.number().optional(),
    orders_count: z.number().optional(),
  }),
});
export type WsAccountInfoUpdate = z.infer<typeof WsAccountInfoUpdateSchema>;

export const WsPositionUpdateSchema = z.object({
  source: z.literal('account_positions'),
  data: z.object({
    symbol: z.string(),
    side: z.string(),
    amount: z.string(),
    entry_price: z.string(),
    margin: z.string(),
    funding: z.string(),
    isolated: z.boolean(),
  }),
});
export type WsPositionUpdate = z.infer<typeof WsPositionUpdateSchema>;

export const WsAccountTradeSchema = z.object({
  source: z.literal('account_trades'),
  data: z.object({
    history_id: z.number().optional(),
    order_id: z.number().optional(),
    client_order_id: z.string().nullable().optional(),
    symbol: z.string(),
    amount: z.string(),
    price: z.string(),
    entry_price: z.string().optional(),
    fee: z.string().optional(),
    pnl: z.string().optional(),
    event_type: z.string(),
    side: z.string(),
    created_at: z.number(),
  }),
});
export type WsAccountTrade = z.infer<typeof WsAccountTradeSchema>;

export const WsOrderUpdateSchema = z.object({
  source: z.literal('account_order_updates'),
  data: z.object({
    order_id: z.number(),
    client_order_id: z.string().nullable().optional(),
    symbol: z.string(),
    side: z.string(),
    amount: z.string().optional(),
    filled_amount: z.string().optional(),
    order_status: z.string().optional(),
    updated_at: z.number(),
  }),
});
export type WsOrderUpdate = z.infer<typeof WsOrderUpdateSchema>;

// Generic fallback for untyped messages
export type WsMessage = Record<string, unknown>;