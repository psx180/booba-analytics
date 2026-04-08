import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { z } from 'zod';
import {
  PacificaAuthError,
  PacificaError,
  PacificaNotFoundError,
  PacificaRateLimitError,
  PacificaServerError,
  PacificaValidationError,
} from './errors';
import type { SignatureHeader, SignedRequestBase } from './types/common';

export const MAINNET_REST_URL = 'https://api.pacifica.fi/api/v1';
export const TESTNET_REST_URL = 'https://test-api.pacifica.fi/api/v1';
export const MAINNET_WS_URL = 'wss://ws.pacifica.fi/ws';
export const TESTNET_WS_URL = 'wss://test-ws.pacifica.fi/ws';

/**
 * Three auth modes:
 *
 * 1. Public (no config needed)
 *    - Market data only. No signing, no wallet address.
 *    - Usage: new PacificaClient()
 *
 * 2. Read-only (walletAddress only)
 *    - Account reads (trade history, positions, margin state).
 *    - Wallet address is passed as a query param — no signing.
 *    - Usage: new PacificaClient({ walletAddress: '...' })
 *
 * 3. Agent key (walletAddress + agentPrivateKey)
 *    - Order placement and trade execution on behalf of the user.
 *    - The agent key is a server-side keypair pre-authorized by the user
 *      via Pacifica's /agent/bind endpoint during onboarding.
 *    - Signatures are made with the agent key; `account` is the user's wallet.
 *    - Usage: new PacificaClient({ walletAddress: '...', agentPrivateKey: '...' })
 *
 * Note: `privateKey` (direct signing) is also supported for dev/testing,
 * where you control the wallet directly. In production, prefer agent key mode.
 */
export interface PacificaClientConfig {
  /** User's wallet address (public key). Required for account reads and agent mode. */
  walletAddress?: string;
  /**
   * Agent's private key (base58-encoded 64-byte keypair).
   * Server-side key pre-authorized by the user. Used for order execution.
   * Requires walletAddress to also be set.
   */
  agentPrivateKey?: string;
  /**
   * Direct private key (base58-encoded 64-byte keypair).
   * Use for dev/testing only when you control the wallet directly.
   * In production, use agentPrivateKey + walletAddress instead.
   */
  privateKey?: string;
  /** Defaults to mainnet */
  network?: 'mainnet' | 'testnet';
  /** Override the REST base URL */
  restUrl?: string;
  /** Override the WebSocket URL */
  wsUrl?: string;
  /** Default signature expiry in ms (default: 5000) */
  defaultExpiryWindow?: number;
}

export class PacificaBaseClient {
  readonly restUrl: string;
  readonly wsUrl: string;
  readonly defaultExpiryWindow: number;

  /** Secret key used for signing (agent key or direct private key) */
  private signingKey?: Uint8Array;
  /** Public key of the signing keypair (agent's pubkey, or direct wallet pubkey) */
  private signingPublicKey?: string;
  /** The user's wallet address — the `account` field in all signed requests */
  private _walletAddress?: string;
  /** Whether we're in agent mode (signing key != wallet key) */
  private _isAgentMode = false;

  constructor(config: PacificaClientConfig = {}) {
    const isTestnet = config.network === 'testnet';
    this.restUrl = config.restUrl ?? (isTestnet ? TESTNET_REST_URL : MAINNET_REST_URL);
    this.wsUrl = config.wsUrl ?? (isTestnet ? TESTNET_WS_URL : MAINNET_WS_URL);
    this.defaultExpiryWindow = config.defaultExpiryWindow ?? 5_000;

    if (config.agentPrivateKey && config.walletAddress) {
      // Mode 3: Agent key — sign as agent, act on behalf of walletAddress
      this.signingKey = bs58.decode(config.agentPrivateKey);
      this.signingPublicKey = bs58.encode(this.signingKey.slice(32));
      this._walletAddress = config.walletAddress;
      this._isAgentMode = true;
    } else if (config.privateKey) {
      // Dev/testing: direct private key
      this.signingKey = bs58.decode(config.privateKey);
      this.signingPublicKey = bs58.encode(this.signingKey.slice(32));
      this._walletAddress = this.signingPublicKey;
      this._isAgentMode = false;
    } else if (config.walletAddress) {
      // Mode 2: Read-only — wallet address for query params, no signing
      this._walletAddress = config.walletAddress;
    }
    // Mode 1: No config — public endpoints only
  }

  /**
   * The wallet address used for account queries.
   * Throws if neither walletAddress nor privateKey was configured.
   */
  get publicKey(): string {
    if (!this._walletAddress) {
      throw new PacificaAuthError(
        'No wallet address configured. Provide walletAddress or privateKey.',
      );
    }
    return this._walletAddress;
  }

  get isAgentMode(): boolean {
    return this._isAgentMode;
  }

  get canSign(): boolean {
    return !!this.signingKey;
  }

  // ─── Signing ───────────────────────────────────────────────────────────────

  /**
   * Recursively sort all object keys (required by Pacifica's signing spec).
   */
  private sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((v) => this.sortKeys(v));
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value as object)
          .sort()
          .map((k) => [k, this.sortKeys((value as Record<string, unknown>)[k])]),
      );
    }
    return value;
  }

  /**
   * Build and sign a request payload. Returns the complete body ready to POST.
   *
   * In agent mode: `account` = user's wallet, `agent_wallet` = agent's pubkey,
   * signature made with agent's private key.
   *
   * In direct mode: `account` = wallet pubkey, no `agent_wallet`.
   */
  sign(
    signatureType: string,
    payload: Record<string, unknown>,
  ): SignedRequestBase & Record<string, unknown> {
    if (!this.signingKey || !this.signingPublicKey) {
      throw new PacificaAuthError(
        'Signing requires agentPrivateKey or privateKey to be configured.',
      );
    }

    const timestamp = Date.now();
    const header: SignatureHeader = {
      type: signatureType,
      timestamp,
      expiry_window: this.defaultExpiryWindow,
    };

    const messageObj = this.sortKeys({ ...header, data: payload });
    const message = JSON.stringify(messageObj);
    const messageBytes = Buffer.from(message, 'utf8');

    const signature = nacl.sign.detached(messageBytes, this.signingKey);
    const signatureB58 = bs58.encode(signature);

    const result: SignedRequestBase & Record<string, unknown> = {
      account: this.publicKey,   // always the user's wallet address
      signature: signatureB58,
      timestamp,
      expiry_window: this.defaultExpiryWindow,
      ...payload,
    };

    if (this._isAgentMode) {
      result.agent_wallet = this.signingPublicKey;
    }

    return result;
  }

  // ─── HTTP ──────────────────────────────────────────────────────────────────

  async get<T>(
    path: string,
    params: Record<string, string | number | boolean | undefined>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const url = new URL(`${this.restUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const response = await fetch(url.toString());
    return this.parseResponse(response, schema);
  }

  async post<T>(
    path: string,
    body: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const response = await fetch(`${this.restUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return this.parseResponse(response, schema);
  }

  private async parseResponse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new PacificaError(`Non-JSON response: ${text}`, response.status);
    }

    switch (response.status) {
      case 401: throw new PacificaAuthError((json as any)?.error ?? 'Unauthorized');
      case 403: throw new PacificaAuthError((json as any)?.error ?? 'Forbidden');
      case 404: throw new PacificaNotFoundError((json as any)?.error ?? 'Not found');
      case 429: throw new PacificaRateLimitError((json as any)?.error ?? 'Rate limited');
      case 400: throw new PacificaValidationError((json as any)?.error ?? 'Bad request');
      case 500: throw new PacificaServerError((json as any)?.error ?? 'Server error');
    }

    if (!response.ok) {
      throw new PacificaError(`HTTP ${response.status}`, response.status, text);
    }

    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new PacificaError(
        `Response validation failed: ${parsed.error.message}`,
        response.status,
        text,
      );
    }
    return parsed.data;
  }
}