import { z } from 'zod';
import { PacificaBaseClient } from '../client';
import { apiResponse, paginatedResponse } from '../types/common';
import {
  AccountFundingEntrySchema,
  AccountInfoSchema,
  AccountSettingsSchema,
  BalanceHistoryEntrySchema,
  EquitySnapshotSchema,
  PositionSchema,
  SubaccountSchema,
  TradeHistoryEntrySchema,
} from '../types/account';

export class AccountAPI {
  constructor(private client: PacificaBaseClient) {}

  // ─── Read endpoints (public, no signing) ───────────────────────────────────

  /** Account balance, equity, margin ratio, available funds */
  async getAccount(account?: string) {
    return this.client.get(
      '/account',
      { account: account ?? this.client.publicKey },
      apiResponse(AccountInfoSchema),
    ).then((r) => r.data);
  }

  /** Per-symbol leverage and margin mode settings */
  async getAccountSettings(account?: string) {
    return this.client.get(
      '/account/settings',
      { account: account ?? this.client.publicKey },
      apiResponse(AccountSettingsSchema),
    ).then((r) => r.data);
  }

  /** Current open positions */
  async getPositions(account?: string) {
    return this.client.get(
      '/positions',
      { account: account ?? this.client.publicKey },
      apiResponse(z.array(PositionSchema)),
    ).then((r) => r.data);
  }

  /**
   * Full trade history with cursor pagination.
   * This is the primary source for journal ingestion.
   */
  async getTradeHistory(params: {
    account?: string;
    symbol?: string;
    startTime?: number;
    endTime?: number;
    limit?: number;
    cursor?: string;
  } = {}) {
    return this.client.get(
      '/trades/history',
      {
        account: params.account ?? this.client.publicKey,
        ...(params.symbol && { symbol: params.symbol }),
        ...(params.startTime !== undefined && { start_time: params.startTime }),
        ...(params.endTime !== undefined && { end_time: params.endTime }),
        ...(params.limit !== undefined && { limit: params.limit }),
        ...(params.cursor !== undefined && { cursor: params.cursor }),
      },
      paginatedResponse(TradeHistoryEntrySchema),
    );
  }

  /**
   * Fetch ALL trade history by following cursors until has_more is false.
   * Use for initial import. For ongoing sync, use getTradeHistory() with cursor.
   */
  async getAllTradeHistory(params: {
    account?: string;
    symbol?: string;
    startTime?: number;
    endTime?: number;
    limit?: number;
  } = {}) {
    const allTrades = [];
    let cursor: string | undefined;

    do {
      const page = await this.getTradeHistory({ ...params, cursor });
      allTrades.push(...page.data);
      cursor = page.next_cursor ?? undefined;
      if (!page.has_more) break;
    } while (cursor);

    return allTrades;
  }

  /** Account-level funding payments received/paid */
  async getFundingHistory(params: {
    account?: string;
    limit?: number;
    cursor?: string;
  } = {}) {
    return this.client.get(
      '/funding/history',
      {
        account: params.account ?? this.client.publicKey,
        ...(params.limit !== undefined && { limit: params.limit }),
        ...(params.cursor !== undefined && { cursor: params.cursor }),
      },
      paginatedResponse(AccountFundingEntrySchema),
    );
  }

  /** Account equity over time — for equity curve chart */
  async getEquityHistory(params: {
    account?: string;
    timeRange: '1d' | '7d' | '14d' | '30d' | 'all';
    startTime?: number;
    endTime?: number;
    limit?: number;
  }) {
    return this.client.get(
      '/portfolio',
      {
        account: params.account ?? this.client.publicKey,
        time_range: params.timeRange,
        ...(params.startTime !== undefined && { start_time: params.startTime }),
        ...(params.endTime !== undefined && { end_time: params.endTime }),
        ...(params.limit !== undefined && { limit: params.limit }),
      },
      apiResponse(z.array(EquitySnapshotSchema)),
    ).then((r) => r.data);
  }

  /** Full balance event log (deposits, withdrawals, trades, funding, etc.) */
  async getBalanceHistory(params: {
    account?: string;
    limit?: number;
    cursor?: string;
  } = {}) {
    return this.client.get(
      '/account/balance/history',
      {
        account: params.account ?? this.client.publicKey,
        ...(params.limit !== undefined && { limit: params.limit }),
        ...(params.cursor !== undefined && { cursor: params.cursor }),
      },
      paginatedResponse(BalanceHistoryEntrySchema),
    );
  }

  // ─── Write endpoints (signed) ──────────────────────────────────────────────

  /** Update max leverage for a symbol */
  async updateLeverage(symbol: string, leverage: number) {
    const body = this.client.sign('update_leverage', { symbol, leverage });
    return this.client.post('/account/leverage', body, z.object({ success: z.boolean() }));
  }

  /** Switch between cross and isolated margin for a symbol */
  async updateMarginMode(symbol: string, isIsolated: boolean) {
    const body = this.client.sign('update_margin_mode', { symbol, is_isolated: isIsolated });
    return this.client.post('/account/margin', body, z.object({ success: z.boolean() }));
  }

  /** List all subaccounts under this main account */
  async listSubaccounts() {
    const body = this.client.sign('list_subaccounts', {});
    return this.client.post(
      '/account/subaccount/list',
      body,
      apiResponse(z.object({ subaccounts: z.array(SubaccountSchema) })),
    ).then((r) => r.data.subaccounts);
  }

  /** Transfer funds between main account and a subaccount */
  async transferFunds(toAccount: string, amount: string) {
    const body = this.client.sign('transfer_funds', { to_account: toAccount, amount });
    return this.client.post('/account/subaccount/transfer', body, z.object({ success: z.boolean() }));
  }
}