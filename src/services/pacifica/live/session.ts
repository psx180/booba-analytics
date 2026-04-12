/**
 * LiveSession — one shared Pacifica websocket per wallet.
 *
 * Architecture:
 *   - Module-level Map<walletAddress, LiveSession>. Multiple browser tabs
 *     for the same wallet reuse a single upstream websocket.
 *   - Each session holds a PacificaWsClient (node `ws`), subscribes once
 *     to account_trades / account_positions / prices, and fans out events
 *     to N SSE subscribers via EventEmitter.
 *   - Refcounts SSE subscribers. When the last one disconnects we tear
 *     the upstream WS down, since Option A of the plan says live data
 *     only needs to flow while the app is open.
 *
 * Why server-side:
 *   The WS needs to (a) persist across page navigations, (b) trigger
 *   server-side DB writes (import + grouping + compute), (c) run without
 *   browser auth. Holding it on the Next.js server and relaying via SSE
 *   does all three without the complexity of a separate worker process.
 */

import { EventEmitter } from 'events';
import { PacificaClient, MAINNET_WS_URL } from '../index';
import { PacificaWsClient } from '../ws/client';
import type { WsAccountTrade, WsPositionUpdate, WsPriceUpdate } from '../types/ws';
import type { Position as PacificaPosition } from '../types/account';
import { handleAccountTrade, type FillEvent } from './fill-handler';

// ─── Event types emitted to SSE subscribers ────────────────────────────────

export interface LivePosition {
  symbol: string;
  side: 'long' | 'short';
  amount: number;
  entryPrice: number;
}

export interface PriceUpdateEvent {
  type: 'price_update';
  data: {
    positions: Array<{
      symbol: string;
      side: 'long' | 'short';
      amount: number;
      entryPrice: number;
      currentPrice: number;
      unrealizedPnl: number;
      unrealizedPnlPct: number;
    }>;
  };
}

export interface OpenSnapshotEvent {
  type: 'open';
  data: { positions: LivePosition[] };
}

export interface StatusEvent {
  type: 'status';
  data: { connected: boolean };
}

export interface ErrorEvent {
  type: 'error';
  data: { message: string };
}

export type LiveEvent = FillEvent | PriceUpdateEvent | OpenSnapshotEvent | StatusEvent | ErrorEvent;

// ─── Session ───────────────────────────────────────────────────────────────

const PRICE_EMIT_INTERVAL_MS = 1_000;

class LiveSession extends EventEmitter {
  private ws: PacificaWsClient;
  private subscriberCount = 0;
  private openPositions = new Map<string, LivePosition>(); // key: `${symbol}:${side}`
  private latestPrices = new Map<string, number>(); // symbol → mark price
  private lastPriceEmitAt = 0;
  private priceEmitTimer: ReturnType<typeof setTimeout> | null = null;
  private fillQueue: Promise<unknown> = Promise.resolve();

  constructor(public readonly walletAddress: string) {
    super();
    const url = process.env.NEXT_PUBLIC_PACIFICA_WS_URL || MAINNET_WS_URL;
    this.ws = new PacificaWsClient({ url });
    // Allow many SSE subscribers without warning.
    this.setMaxListeners(100);
  }

  // ── Lifecycle ──

  async start(): Promise<void> {
    await this.fetchInitialPositions();
    this.wireHandlers();
    this.ws.connect();
  }

  stop(): void {
    if (this.priceEmitTimer) clearTimeout(this.priceEmitTimer);
    this.ws.disconnect();
    this.removeAllListeners();
  }

  addSubscriber(): void {
    this.subscriberCount++;
  }

  removeSubscriber(): boolean {
    this.subscriberCount = Math.max(0, this.subscriberCount - 1);
    return this.subscriberCount === 0;
  }

  getOpenPositions(): LivePosition[] {
    return Array.from(this.openPositions.values());
  }

  // ── Setup ──

  private async fetchInitialPositions(): Promise<void> {
    try {
      const client = new PacificaClient({
        walletAddress: this.walletAddress,
        apiConfigKey: process.env.PF_API_KEY,
      });
      const positions = await client.account.getPositions(this.walletAddress);
      for (const p of positions) {
        this.upsertPosition(p);
      }
      console.log(
        `[live ${short(this.walletAddress)}] loaded ${positions.length} open position(s) from REST`,
      );
    } catch (err) {
      console.error('[live] initial positions fetch failed', err);
    }
  }

  private wireHandlers(): void {
    this.ws.on('connected', () => {
      console.log(`[live ${short(this.walletAddress)}] ws connected`);
      this.emit('event', { type: 'status', data: { connected: true } } as StatusEvent);

      // Subscribe once. Re-subscription on reconnect is handled inside the client.
      this.ws.subscribe({ source: 'account_trades', account: this.walletAddress });
      this.ws.subscribe({ source: 'account_positions', account: this.walletAddress });
      this.ws.subscribe({ source: 'prices' });
    });

    this.ws.on('disconnected', () => {
      console.log(`[live ${short(this.walletAddress)}] ws disconnected`);
      this.emit('event', { type: 'status', data: { connected: false } } as StatusEvent);
    });

    this.ws.on('reconnecting', (attempt: number, delay: number) => {
      console.log(
        `[live ${short(this.walletAddress)}] ws reconnecting attempt=${attempt} delay=${delay}ms`,
      );
    });

    this.ws.on('error', (err: Error) => {
      console.error(`[live ${short(this.walletAddress)}] ws error`, err);
      this.emit('event', { type: 'error', data: { message: err.message } } as ErrorEvent);
    });

    this.ws.on('message', (msg) => {
      const source = (msg as any)?.source ?? (msg as any)?.channel;
      if (source === 'account_trades') {
        this.onAccountTrade((msg as any).data as WsAccountTrade['data']);
      } else if (source === 'account_positions') {
        this.onAccountPosition((msg as any).data as WsPositionUpdate['data']);
      } else if (source === 'prices') {
        this.onPrices((msg as any).data as WsPriceUpdate['data']);
      }
    });
  }

  // ── Handlers ──

  private onAccountTrade(data: WsAccountTrade['data']): void {
    console.log(
      `[live ${short(this.walletAddress)}] fill ${data.side} ${data.amount} ${data.symbol} @ ${data.price}`,
    );
    // Serialize fill processing so two near-simultaneous partial fills can't
    // race on the "find open position" lookup and create two positions.
    this.fillQueue = this.fillQueue
      .then(() => handleAccountTrade(this.walletAddress, data))
      .then((events) => {
        for (const e of events) this.emit('event', e);
      })
      .catch((err) => {
        console.error('[live] fill handler failed', err);
        this.emit('event', {
          type: 'error',
          data: { message: `Failed to process fill: ${String(err)}` },
        } as ErrorEvent);
      });
  }

  private onAccountPosition(data: WsPositionUpdate['data']): void {
    const amount = parseFloat(data.amount);
    const side = data.side as 'long' | 'short';
    const key = `${data.symbol}:${side}`;

    if (amount === 0) {
      this.openPositions.delete(key);
    } else {
      this.openPositions.set(key, {
        symbol: data.symbol,
        side,
        amount,
        entryPrice: parseFloat(data.entry_price),
      });
    }
  }

  private onPrices(data: WsPriceUpdate['data']): void {
    if (!Array.isArray(data)) return;
    let touched = false;
    const openSymbols = new Set(
      Array.from(this.openPositions.values()).map((p) => p.symbol),
    );
    for (const row of data) {
      // Only track symbols we actually care about.
      if (!openSymbols.has(row.symbol)) continue;
      const mark = parseFloat(row.mark);
      if (!Number.isFinite(mark)) continue;
      this.latestPrices.set(row.symbol, mark);
      touched = true;
    }
    if (touched) this.scheduleEmitPrices();
  }

  // ── Price emission ──
  //
  // Pacifica's prices channel streams ~10x/second with every symbol in
  // one frame. Emitting every frame to SSE is wasteful and flashes the
  // UI. Throttle to at most once per second.

  private scheduleEmitPrices(): void {
    if (this.priceEmitTimer) return;
    const sinceLast = Date.now() - this.lastPriceEmitAt;
    const wait = Math.max(0, PRICE_EMIT_INTERVAL_MS - sinceLast);
    this.priceEmitTimer = setTimeout(() => {
      this.priceEmitTimer = null;
      this.emitPrices();
    }, wait);
  }

  private emitPrices(): void {
    this.lastPriceEmitAt = Date.now();
    const positions: PriceUpdateEvent['data']['positions'] = [];
    for (const p of this.openPositions.values()) {
      const px = this.latestPrices.get(p.symbol);
      if (px == null || p.entryPrice === 0) continue;
      const dir = p.side === 'long' ? 1 : -1;
      const unrealizedPnl = (px - p.entryPrice) * p.amount * dir;
      const notional = p.entryPrice * p.amount;
      const unrealizedPnlPct = notional === 0 ? 0 : (unrealizedPnl / notional) * 100;
      positions.push({
        symbol: p.symbol,
        side: p.side,
        amount: p.amount,
        entryPrice: p.entryPrice,
        currentPrice: px,
        unrealizedPnl,
        unrealizedPnlPct,
      });
    }
    if (positions.length > 0) {
      this.emit('event', { type: 'price_update', data: { positions } } as PriceUpdateEvent);
    }
  }

  private upsertPosition(p: PacificaPosition): void {
    const key = `${p.symbol}:${p.side}`;
    const amount = parseFloat(p.amount);
    if (amount === 0) {
      this.openPositions.delete(key);
      return;
    }
    this.openPositions.set(key, {
      symbol: p.symbol,
      side: p.side,
      amount,
      entryPrice: parseFloat(p.entry_price),
    });
  }
}

// ─── Registry ──────────────────────────────────────────────────────────────

const sessions = new Map<string, LiveSession>();

export async function acquireSession(walletAddress: string): Promise<LiveSession> {
  let s = sessions.get(walletAddress);
  if (!s) {
    s = new LiveSession(walletAddress);
    sessions.set(walletAddress, s);
    await s.start();
  }
  s.addSubscriber();
  return s;
}

export function releaseSession(walletAddress: string): void {
  const s = sessions.get(walletAddress);
  if (!s) return;
  const empty = s.removeSubscriber();
  if (empty) {
    s.stop();
    sessions.delete(walletAddress);
    console.log(`[live ${short(walletAddress)}] session torn down`);
  }
}

function short(addr: string): string {
  return addr.length > 10 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
}

export type { LiveSession };
