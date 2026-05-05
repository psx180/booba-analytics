import { z } from 'zod';

// ─── Open Orders & Order History ─────────────────────────────────────────────

export const OrderSchema = z.object({
  order_id: z.number(),
  client_order_id: z.string().nullable().optional(),
  symbol: z.string(),
  side: z.enum(['bid', 'ask']),
  price: z.string().nullable().optional(),
  initial_price: z.string().nullable().optional(),
  average_filled_price: z.string().nullable().optional(),
  initial_amount: z.string().optional(),
  amount: z.string().optional(),
  filled_amount: z.string().optional(),
  cancelled_amount: z.string().nullable().optional(),
  order_type: z.string(),
  order_status: z.string().optional(),
  reduce_only: z.boolean().optional(),
  stop_price: z.string().nullable().optional(),
  stop_parent_order_id: z.number().nullable().optional(),
  reason: z.string().nullable().optional(),
  // Present in live API responses but undocumented; without these the Zod
  // schema strips them silently and we lose the data.
  trigger_price_type: z.string().nullable().optional(),
  instrument_type: z.string().nullable().optional(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type Order = z.infer<typeof OrderSchema>;

// ─── TWAP Orders ─────────────────────────────────────────────────────────────

export const TwapOrderSchema = z.object({
  order_id: z.number().optional(),
  client_order_id: z.string().nullable().optional(),
  symbol: z.string(),
  side: z.string(),
  amount: z.string(),
  filled_amount: z.string().optional(),
  status: z.string().optional(),
  duration_in_seconds: z.number().optional(),
  created_at: z.number().optional(),
  updated_at: z.number().optional(),
});
export type TwapOrder = z.infer<typeof TwapOrderSchema>;

// ─── Request param types ─────────────────────────────────────────────────────

export interface CreateLimitOrderParams {
  symbol: string;
  side: 'bid' | 'ask';
  price: string;
  amount: string;
  reduce_only?: boolean;
  tif?: 'GTC' | 'IOC' | 'FOK' | 'ALO';
  client_order_id?: string;
  take_profit?: TpSlLevel;
  stop_loss?: TpSlLevel;
}

export interface CreateMarketOrderParams {
  symbol: string;
  side: 'bid' | 'ask';
  amount: string;
  reduce_only?: boolean;
  slippage_percent?: string;
  client_order_id?: string;
  take_profit?: TpSlLevel;
  stop_loss?: TpSlLevel;
}

export interface CreateStopOrderParams {
  symbol: string;
  side: 'bid' | 'ask';
  reduce_only: boolean;
  stop_order: StopOrderLevel;
}

export interface StopOrderLevel {
  stop_price: string;
  limit_price?: string;
  amount: string;
  client_order_id?: string;
}

export interface TpSlLevel {
  stop_price: string;
  limit_price?: string;
  amount?: string;
  client_order_id?: string;
}

export interface SetPositionTpSlParams {
  symbol: string;
  side: 'bid' | 'ask';
  take_profit?: TpSlLevel;
  stop_loss?: TpSlLevel;
}

export interface CancelOrderParams {
  symbol: string;
  order_id?: number;
  client_order_id?: string;
}

export interface CancelAllOrdersParams {
  all_symbols?: boolean;
  symbol?: string;
  exclude_reduce_only?: boolean;
}

export interface CancelStopOrderParams {
  symbol: string;
  order_id?: number;
  client_order_id?: string;
}

export interface EditOrderParams {
  symbol: string;
  price: string;
  amount: string;
  order_id?: number;
  client_order_id?: string;
}

export type BatchOrderAction =
  | { type: 'Create'; data: Record<string, unknown> }
  | { type: 'Cancel'; data: Record<string, unknown> };

export interface CreateTwapOrderParams {
  symbol: string;
  side: 'bid' | 'ask';
  amount: string;
  reduce_only?: boolean;
  slippage_percent?: string;
  duration_in_seconds: number;
  client_order_id?: string;
}

export interface CancelTwapOrderParams {
  symbol: string;
  order_id?: number;
  client_order_id?: string;
}