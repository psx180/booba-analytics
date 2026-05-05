import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { PacificaBaseClient } from '../client';
import { apiResponse, paginatedResponse } from '../types/common';
import { OrderSchema, TwapOrderSchema } from '../types/orders';
import type {
  BatchOrderAction,
  CancelAllOrdersParams,
  CancelOrderParams,
  CancelStopOrderParams,
  CancelTwapOrderParams,
  CreateLimitOrderParams,
  CreateMarketOrderParams,
  CreateStopOrderParams,
  CreateTwapOrderParams,
  EditOrderParams,
  SetPositionTpSlParams,
} from '../types/orders';

const OrderIdResponse = z.object({ order_id: z.number() });
const SuccessResponse = z.object({ success: z.boolean() });

export class OrdersAPI {
  constructor(private client: PacificaBaseClient) {}

  // ─── Read ──────────────────────────────────────────────────────────────────

  async getOpenOrders(account?: string) {
    return this.client.get(
      '/orders',
      { account: account ?? this.client.publicKey },
      apiResponse(z.array(OrderSchema)),
    ).then((r) => r.data);
  }

  async getOrderHistory(params: { account?: string; limit?: number; cursor?: string } = {}) {
    return this.client.get(
      '/orders/history',
      {
        account: params.account ?? this.client.publicKey,
        ...(params.limit !== undefined && { limit: params.limit }),
        ...(params.cursor !== undefined && { cursor: params.cursor }),
      },
      paginatedResponse(OrderSchema),
    );
  }

  /**
   * Fetch ALL order history by following cursors until has_more is false.
   * Mirrors AccountAPI.getAllTradeHistory.
   */
  async getAllOrderHistory(params: { account?: string; limit?: number } = {}) {
    const all: Awaited<ReturnType<typeof this.getOrderHistory>>['data'] = [];
    let cursor: string | undefined;

    do {
      const page = await this.getOrderHistory({ ...params, cursor });
      all.push(...page.data);
      cursor = page.next_cursor ?? undefined;
      if (!page.has_more) break;
    } while (cursor);

    return all;
  }

  async getOpenTwapOrders(account?: string) {
    return this.client.get(
      '/orders/twap',
      { account: account ?? this.client.publicKey },
      apiResponse(z.array(TwapOrderSchema)),
    ).then((r) => r.data);
  }

  async getTwapOrderHistory(account?: string) {
    return this.client.get(
      '/orders/twap/history',
      { account: account ?? this.client.publicKey },
      apiResponse(z.array(TwapOrderSchema)),
    ).then((r) => r.data);
  }

  async getTwapOrderHistoryById(orderId: number) {
    return this.client.get(
      '/orders/twap/history_by_id',
      { order_id: orderId },
      apiResponse(TwapOrderSchema),
    ).then((r) => r.data);
  }

  // ─── Write ─────────────────────────────────────────────────────────────────

  async createLimitOrder(params: CreateLimitOrderParams) {
    const payload = {
      symbol: params.symbol,
      side: params.side,
      price: params.price,
      amount: params.amount,
      reduce_only: params.reduce_only ?? false,
      tif: params.tif ?? 'GTC',
      client_order_id: params.client_order_id ?? uuidv4(),
      ...(params.take_profit && { take_profit: params.take_profit }),
      ...(params.stop_loss && { stop_loss: params.stop_loss }),
    };
    const body = this.client.sign('create_order', payload);
    return this.client.post('/orders/create', body, OrderIdResponse);
  }

  async createMarketOrder(params: CreateMarketOrderParams) {
    const payload = {
      symbol: params.symbol,
      side: params.side,
      amount: params.amount,
      reduce_only: params.reduce_only ?? false,
      slippage_percent: params.slippage_percent ?? '0.5',
      client_order_id: params.client_order_id ?? uuidv4(),
      ...(params.take_profit && { take_profit: params.take_profit }),
      ...(params.stop_loss && { stop_loss: params.stop_loss }),
    };
    const body = this.client.sign('create_market_order', payload);
    return this.client.post('/orders/create_market', body, OrderIdResponse);
  }

  async createStopOrder(params: CreateStopOrderParams) {
    const payload = {
      symbol: params.symbol,
      side: params.side,
      reduce_only: params.reduce_only,
      stop_order: params.stop_order,
    };
    const body = this.client.sign('create_stop_order', payload);
    return this.client.post('/orders/stop/create', body, OrderIdResponse);
  }

  async setPositionTpSl(params: SetPositionTpSlParams) {
    const payload = {
      symbol: params.symbol,
      side: params.side,
      ...(params.take_profit && { take_profit: params.take_profit }),
      ...(params.stop_loss && { stop_loss: params.stop_loss }),
    };
    const body = this.client.sign('set_position_tpsl', payload);
    return this.client.post('/positions/tpsl', body, SuccessResponse);
  }

  async cancelOrder(params: CancelOrderParams) {
    const payload: Record<string, unknown> = { symbol: params.symbol };
    if (params.order_id !== undefined) payload.order_id = params.order_id;
    if (params.client_order_id !== undefined) payload.client_order_id = params.client_order_id;
    const body = this.client.sign('cancel_order', payload);
    return this.client.post('/orders/cancel', body, SuccessResponse);
  }

  async cancelAllOrders(params: CancelAllOrdersParams = {}) {
    const payload: Record<string, unknown> = {
      all_symbols: params.all_symbols ?? true,
      exclude_reduce_only: params.exclude_reduce_only ?? false,
      ...(params.symbol && { symbol: params.symbol }),
    };
    const body = this.client.sign('cancel_all_orders', payload);
    return this.client.post('/orders/cancel_all', body, SuccessResponse);
  }

  async cancelStopOrder(params: CancelStopOrderParams) {
    const payload: Record<string, unknown> = { symbol: params.symbol };
    if (params.order_id !== undefined) payload.order_id = params.order_id;
    if (params.client_order_id !== undefined) payload.client_order_id = params.client_order_id;
    const body = this.client.sign('cancel_stop_order', payload);
    return this.client.post('/orders/stop/cancel', body, SuccessResponse);
  }

  async editOrder(params: EditOrderParams) {
    const payload: Record<string, unknown> = {
      symbol: params.symbol,
      price: params.price,
      amount: params.amount,
    };
    if (params.order_id !== undefined) payload.order_id = params.order_id;
    if (params.client_order_id !== undefined) payload.client_order_id = params.client_order_id;
    const body = this.client.sign('edit_order', payload);
    return this.client.post('/orders/edit', body, OrderIdResponse);
  }

  /**
   * Submit multiple create/cancel operations atomically.
   * Each action must be pre-signed individually — use signBatchAction() to build each one.
   */
  async batchOrders(actions: BatchOrderAction[]) {
    return this.client.post(
      '/orders/batch',
      { actions },
      z.unknown(),
    );
  }

  /**
   * Helper: build a signed action object for use in batchOrders().
   * type: 'Create' for limit orders, 'Cancel' for cancellations.
   */
  signBatchAction(
    type: 'Create' | 'Cancel',
    signatureType: string,
    payload: Record<string, unknown>,
  ): BatchOrderAction {
    const signed = this.client.sign(signatureType, payload);
    return { type, data: signed };
  }

  // ─── TWAP ──────────────────────────────────────────────────────────────────

  async createTwapOrder(params: CreateTwapOrderParams) {
    const payload = {
      symbol: params.symbol,
      side: params.side,
      amount: params.amount,
      reduce_only: params.reduce_only ?? false,
      slippage_percent: params.slippage_percent ?? '0.5',
      duration_in_seconds: params.duration_in_seconds,
      client_order_id: params.client_order_id ?? uuidv4(),
    };
    const body = this.client.sign('create_twap_order', payload);
    return this.client.post('/orders/twap/create', body, z.unknown());
  }

  async cancelTwapOrder(params: CancelTwapOrderParams) {
    const payload: Record<string, unknown> = { symbol: params.symbol };
    if (params.order_id !== undefined) payload.order_id = params.order_id;
    if (params.client_order_id !== undefined) payload.client_order_id = params.client_order_id;
    const body = this.client.sign('cancel_twap_order', payload);
    return this.client.post('/orders/twap/cancel', body, SuccessResponse);
  }
}