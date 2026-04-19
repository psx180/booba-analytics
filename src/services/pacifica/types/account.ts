
import { z } from 'zod';

// ─── Account Info (/api/v1/account) ──────────────────────────────────────────

export const AccountInfoSchema = z.object({
  balance: z.string(),
  fee_level: z.number(),
  maker_fee: z.string(),
  taker_fee: z.string(),
  account_equity: z.string(),
  available_to_spend: z.string(),
  available_to_withdraw: z.string(),
  pending_balance: z.string(),
  total_margin_used: z.string(),
  cross_mmr: z.string(),
  positions_count: z.number(),
  orders_count: z.number(),
  stop_orders_count: z.number(),
  updated_at: z.number(),
  use_ltp_for_stop_orders: z.boolean(),
});
export type AccountInfo = z.infer<typeof AccountInfoSchema>;

// ─── Account Settings (/api/v1/account/settings) ─────────────────────────────

export const MarginSettingSchema = z.object({
  symbol: z.string(),
  isolated: z.boolean(),
  leverage: z.number(),
  created_at: z.number(),
  updated_at: z.number(),
});

export const AccountSettingsSchema = z.object({
  auto_lend_disabled: z.boolean().optional(),
  margin_settings: z.array(MarginSettingSchema).optional(),
  spot_settings: z.unknown().optional(),
});
export type AccountSettings = z.infer<typeof AccountSettingsSchema>;

// ─── Position (/api/v1/positions) ────────────────────────────────────────────

// Pacifica's positions endpoint emits `side` in book semantics: `bid` for a
// long position, `ask` for a short one. Normalize to long/short so the rest
// of the codebase keeps working in directional terms.
const PositionSideSchema = z.preprocess(
  (v) => (v === 'bid' ? 'long' : v === 'ask' ? 'short' : v),
  z.enum(['long', 'short']),
);

export const PositionSchema = z.object({
  symbol: z.string(),
  side: PositionSideSchema,
  amount: z.string(),
  entry_price: z.string(),
  margin: z.string(),
  funding: z.string(),
  isolated: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type Position = z.infer<typeof PositionSchema>;

// ─── Trade History (/api/v1/trades/history) ───────────────────────────────────

export const TradeHistoryEntrySchema = z.object({
  history_id: z.number(),
  order_id: z.number(),
  client_order_id: z.string().nullable().optional(),
  symbol: z.string(),
  amount: z.string(),
  price: z.string(),
  entry_price: z.string(),
  fee: z.string(),
  pnl: z.string(),
  event_type: z.string(),
  side: z.string(),
  created_at: z.number(),
  cause: z.string(),
});
export type TradeHistoryEntry = z.infer<typeof TradeHistoryEntrySchema>;

// ─── Account Funding History (/api/v1/funding/history) ───────────────────────

export const AccountFundingEntrySchema = z.object({
  history_id: z.number(),
  symbol: z.string(),
  side: z.enum(['bid', 'ask']),
  amount: z.string(),
  payout: z.string(),
  rate: z.string(),
  created_at: z.number(),
});
export type AccountFundingEntry = z.infer<typeof AccountFundingEntrySchema>;

// ─── Equity History (/api/v1/portfolio) ──────────────────────────────────────

export const EquitySnapshotSchema = z.object({
  account_equity: z.string(),
  pnl: z.string(),
  timestamp: z.number(),
});
export type EquitySnapshot = z.infer<typeof EquitySnapshotSchema>;

// ─── Balance History (/api/v1/account/balance/history) ───────────────────────

export const BalanceHistoryEntrySchema = z.object({
  amount: z.string(),
  balance: z.string(),
  pending_balance: z.string(),
  event_type: z.string(),
  created_at: z.number(),
});
export type BalanceHistoryEntry = z.infer<typeof BalanceHistoryEntrySchema>;

// ─── Subaccounts (/api/v1/account/subaccount/list) ───────────────────────────

export const SubaccountSchema = z.object({
  address: z.string(),
  balance: z.string(),
  fee_level: z.number(),
  fee_mode: z.string(),
  created_at: z.number(),
});
export type Subaccount = z.infer<typeof SubaccountSchema>;