import type { CandleInterval } from '../types/market';
import type {
  WsAccountInfoUpdate,
  WsAccountTrade,
  WsMessage,
  WsOrderUpdate,
  WsPositionUpdate,
  WsPriceUpdate,
} from '../types/ws';
import type { PacificaWsClient } from './client';

/**
 * High-level subscription helpers. Each method returns an unsubscribe function.
 * The callback receives typed (but loosely validated) message data.
 */
export class PacificaSubscriptions {
  constructor(private ws: PacificaWsClient) {}

  // ─── Market channels ───────────────────────────────────────────────────────

  /** All symbols' mark/oracle/funding prices as they update */
  onPrices(callback: (data: WsPriceUpdate['data']) => void): () => void {
    const handler = (msg: WsMessage) => {
      if ((msg as any).source === 'prices') {
        callback((msg as any).data);
      }
    };
    this.ws.subscribe({ source: 'prices' });
    this.ws.on('message', handler);
    return () => {
      this.ws.unsubscribe({ source: 'prices' });
      this.ws.off('message', handler);
    };
  }

  /** Orderbook updates for a symbol */
  onOrderbook(
    symbol: string,
    callback: (data: WsMessage) => void,
    aggLevel?: number,
  ): () => void {
    const params = { source: 'orderbook' as const, symbol, ...(aggLevel !== undefined && { agg_level: aggLevel }) };
    const handler = (msg: WsMessage) => {
      if ((msg as any).source === 'orderbook' && (msg as any).s === symbol) {
        callback(msg);
      }
    };
    this.ws.subscribe(params);
    this.ws.on('message', handler);
    return () => {
      this.ws.unsubscribe(params);
      this.ws.off('message', handler);
    };
  }

  /** Best bid/offer updates for a symbol */
  onBbo(symbol: string, callback: (data: WsMessage) => void): () => void {
    const params = { source: 'bbo' as const, symbol };
    const handler = (msg: WsMessage) => {
      if ((msg as any).source === 'bbo' && (msg as any).symbol === symbol) {
        callback(msg);
      }
    };
    this.ws.subscribe(params);
    this.ws.on('message', handler);
    return () => {
      this.ws.unsubscribe(params);
      this.ws.off('message', handler);
    };
  }

  /** Public trade stream for a symbol */
  onTrades(symbol: string, callback: (data: WsMessage) => void): () => void {
    const params = { source: 'trades' as const, symbol };
    const handler = (msg: WsMessage) => {
      if ((msg as any).source === 'trades' && (msg as any).symbol === symbol) {
        callback(msg);
      }
    };
    this.ws.subscribe(params);
    this.ws.on('message', handler);
    return () => {
      this.ws.unsubscribe(params);
      this.ws.off('message', handler);
    };
  }

  /** Candle updates for a symbol/interval */
  onCandle(
    symbol: string,
    interval: CandleInterval,
    callback: (data: WsMessage) => void,
  ): () => void {
    const params = { source: 'candle' as const, symbol, interval };
    const handler = (msg: WsMessage) => {
      if ((msg as any).source === 'candle' && (msg as any).symbol === symbol) {
        callback(msg);
      }
    };
    this.ws.subscribe(params);
    this.ws.on('message', handler);
    return () => {
      this.ws.unsubscribe(params);
      this.ws.off('message', handler);
    };
  }

  // ─── Account channels ──────────────────────────────────────────────────────

  /** Account equity, balance, margin ratio changes — drives Booba's vitals bar */
  onAccountInfo(account: string, callback: (data: WsAccountInfoUpdate['data']) => void): () => void {
    const params = { source: 'account_info' as const, account };
    const handler = (msg: WsMessage) => {
      if ((msg as any).source === 'account_info') {
        callback((msg as any).data);
      }
    };
    this.ws.subscribe(params);
    this.ws.on('message', handler);
    return () => {
      this.ws.unsubscribe(params);
      this.ws.off('message', handler);
    };
  }

  /** Position changes — drives the stress tester and margin gauge */
  onPositions(account: string, callback: (data: WsPositionUpdate['data']) => void): () => void {
    const params = { source: 'account_positions' as const, account };
    const handler = (msg: WsMessage) => {
      if ((msg as any).source === 'account_positions') {
        callback((msg as any).data);
      }
    };
    this.ws.subscribe(params);
    this.ws.on('message', handler);
    return () => {
      this.ws.unsubscribe(params);
      this.ws.off('message', handler);
    };
  }

  /** Account trade events — triggers the post-execution popup */
  onAccountTrades(account: string, callback: (data: WsAccountTrade['data']) => void): () => void {
    const params = { source: 'account_trades' as const, account };
    const handler = (msg: WsMessage) => {
      if ((msg as any).source === 'account_trades') {
        callback((msg as any).data);
      }
    };
    this.ws.subscribe(params);
    this.ws.on('message', handler);
    return () => {
      this.ws.unsubscribe(params);
      this.ws.off('message', handler);
    };
  }

  /** Order status changes (filled, cancelled, partially filled) */
  onOrderUpdates(account: string, callback: (data: WsOrderUpdate['data']) => void): () => void {
    const params = { source: 'account_order_updates' as const, account };
    const handler = (msg: WsMessage) => {
      if ((msg as any).source === 'account_order_updates') {
        callback((msg as any).data);
      }
    };
    this.ws.subscribe(params);
    this.ws.on('message', handler);
    return () => {
      this.ws.unsubscribe(params);
      this.ws.off('message', handler);
    };
  }

  /** Account leverage changes */
  onAccountLeverage(account: string, callback: (data: WsMessage) => void): () => void {
    const params = { source: 'account_leverage' as const, account };
    const handler = (msg: WsMessage) => {
      if ((msg as any).source === 'account_leverage') callback(msg);
    };
    this.ws.subscribe(params);
    this.ws.on('message', handler);
    return () => {
      this.ws.unsubscribe(params);
      this.ws.off('message', handler);
    };
  }

  /** Account margin mode changes */
  onAccountMargin(account: string, callback: (data: WsMessage) => void): () => void {
    const params = { source: 'account_margin' as const, account };
    const handler = (msg: WsMessage) => {
      if ((msg as any).source === 'account_margin') callback(msg);
    };
    this.ws.subscribe(params);
    this.ws.on('message', handler);
    return () => {
      this.ws.unsubscribe(params);
      this.ws.off('message', handler);
    };
  }
}