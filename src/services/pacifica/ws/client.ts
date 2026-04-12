import WebSocket from 'ws';
import { EventEmitter } from 'events';
import type { WsMessage, WsSubscribeParams } from '../types/ws';

export interface WsClientConfig {
  url: string;
  /** Base delay for exponential backoff (default: 1000ms). Doubles each attempt, capped at maxReconnectDelay. */
  baseReconnectDelay?: number;
  /** Maximum delay between reconnect attempts (default: 30_000ms). */
  maxReconnectDelay?: number;
  /** Max reconnect attempts before giving up (default: 10). */
  maxReconnectAttempts?: number;
  /** Interval between pings in ms (default: 30_000). Pacifica closes idle connections at 60s. */
  heartbeatIntervalMs?: number;
}

export class PacificaWsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private baseReconnectDelay: number;
  private maxReconnectDelay: number;
  private maxReconnectAttempts: number;
  private heartbeatIntervalMs: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private activeSubscriptions: WsSubscribeParams[] = [];
  private shouldReconnect = true;

  constructor(private config: WsClientConfig) {
    super();
    this.baseReconnectDelay = config.baseReconnectDelay ?? 1_000;
    this.maxReconnectDelay = config.maxReconnectDelay ?? 30_000;
    this.maxReconnectAttempts = config.maxReconnectAttempts ?? 10;
    this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? 30_000;
  }

  connect(): void {
    this.ws = new WebSocket(this.config.url);

    this.ws.on('open', () => {
      this.reconnectAttempts = 0;
      this.emit('connected');
      // Resubscribe to all active channels after reconnect
      for (const params of this.activeSubscriptions) {
        this.sendSubscribe(params);
      }
      this.startHeartbeat();
    });

    this.ws.on('message', (raw: WebSocket.RawData) => {
      try {
        const data = JSON.parse(raw.toString()) as WsMessage;
        this.emit('message', data);
        // Also emit by source for targeted listeners
        const source = (data as any)?.source ?? (data as any)?.params?.source;
        if (source) this.emit(`source:${source}`, data);
      } catch {
        this.emit('parse_error', raw.toString());
      }
    });

    this.ws.on('error', (err) => {
      this.emit('error', err);
    });

    this.ws.on('close', () => {
      this.stopHeartbeat();
      this.emit('disconnected');
      if (this.shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
        const attempt = this.reconnectAttempts;
        this.reconnectAttempts++;
        // Exponential backoff: base * 2^attempt, capped at max. attempt 0 → 1s, 1 → 2s, 2 → 4s, … capped at 30s.
        const delay = Math.min(this.baseReconnectDelay * 2 ** attempt, this.maxReconnectDelay);
        this.emit('reconnecting', this.reconnectAttempts, delay);
        setTimeout(() => this.connect(), delay);
      } else if (this.shouldReconnect) {
        this.emit('reconnect_exhausted');
      }
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      // Pacifica uses `{"method": "ping"}` — the server replies `{"channel": "pong"}`.
      // Keeps the connection alive past Pacifica's 60s idle cutoff.
      this.sendRaw({ method: 'ping' });
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private sendRaw(message: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private sendSubscribe(params: WsSubscribeParams): void {
    this.sendRaw({ method: 'subscribe', params });
  }

  private sendUnsubscribe(params: WsSubscribeParams): void {
    this.sendRaw({ method: 'unsubscribe', params });
  }

  subscribe(params: WsSubscribeParams): void {
    // Track for reconnect replay
    const exists = this.activeSubscriptions.some(
      (s) => JSON.stringify(s) === JSON.stringify(params),
    );
    if (!exists) this.activeSubscriptions.push(params);
    this.sendSubscribe(params);
  }

  unsubscribe(params: WsSubscribeParams): void {
    this.activeSubscriptions = this.activeSubscriptions.filter(
      (s) => JSON.stringify(s) !== JSON.stringify(params),
    );
    this.sendUnsubscribe(params);
  }

  /** Send a signed action (create order, cancel order, etc.) via WebSocket */
  sendAction(id: string, action: Record<string, unknown>): void {
    this.sendRaw({ id, params: action });
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}