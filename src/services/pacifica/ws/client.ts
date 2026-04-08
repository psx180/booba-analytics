import WebSocket from 'ws';
import { EventEmitter } from 'events';
import type { WsMessage, WsSubscribeParams } from '../types/ws';

export interface WsClientConfig {
  url: string;
  /** Milliseconds between reconnect attempts (default: 3000) */
  reconnectDelay?: number;
  /** Max reconnect attempts before giving up (default: Infinity) */
  maxReconnectAttempts?: number;
}

export class PacificaWsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectDelay: number;
  private maxReconnectAttempts: number;
  private activeSubscriptions: WsSubscribeParams[] = [];
  private shouldReconnect = true;

  constructor(private config: WsClientConfig) {
    super();
    this.reconnectDelay = config.reconnectDelay ?? 3_000;
    this.maxReconnectAttempts = config.maxReconnectAttempts ?? Infinity;
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
      this.emit('disconnected');
      if (this.shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        this.emit('reconnecting', this.reconnectAttempts);
        setTimeout(() => this.connect(), this.reconnectDelay);
      }
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.ws?.close();
    this.ws = null;
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