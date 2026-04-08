import { PacificaBaseClient, PacificaClientConfig } from './client';
import { AccountAPI } from './rest/account';
import { AgentAPI } from './rest/agent';
import { LakeAPI } from './rest/lake';
import { MarketAPI } from './rest/market';
import { OrdersAPI } from './rest/orders';
import { PacificaWsClient } from './ws/client';
import { PacificaSubscriptions } from './ws/subscriptions';

export class PacificaClient {
  readonly market: MarketAPI;
  readonly account: AccountAPI;
  readonly orders: OrdersAPI;
  readonly agent: AgentAPI;
  readonly lake: LakeAPI;
  readonly ws: PacificaWsClient;
  readonly subscribe: PacificaSubscriptions;

  private base: PacificaBaseClient;

  constructor(config: PacificaClientConfig = {}) {
    this.base = new PacificaBaseClient(config);
    this.market = new MarketAPI(this.base);
    this.account = new AccountAPI(this.base);
    this.orders = new OrdersAPI(this.base);
    this.agent = new AgentAPI(this.base);
    this.lake = new LakeAPI(this.base);
    this.ws = new PacificaWsClient({ url: this.base.wsUrl });
    this.subscribe = new PacificaSubscriptions(this.ws);
  }

  /** Public key of the configured wallet */
  get publicKey(): string {
    return this.base.publicKey;
  }

  /** Connect WebSocket. Call this once after constructing the client. */
  connectWs(): void {
    this.ws.connect();
  }

  /** Disconnect WebSocket. */
  disconnectWs(): void {
    this.ws.disconnect();
  }
}

// Re-export everything consumers might need
export { PacificaBaseClient } from './client';
export { MAINNET_REST_URL, MAINNET_WS_URL, TESTNET_REST_URL, TESTNET_WS_URL } from './client';
export * from './errors';
export * from './types/account';
export * from './types/common';
export * from './types/market';
export * from './types/orders';
export * from './types/ws';