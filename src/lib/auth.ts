/**
 * auth.ts — server-side wallet resolution from a request.
 *
 * The single source of truth for "who is making this API call?". Every
 * route eventually goes through `getAuthenticatedWallet(request)`, which
 * either returns the connected Solana wallet address (verified against
 * Privy) or null. The wrapper in api-auth.ts converts a null result into
 * a 401.
 *
 * Two modes:
 *
 *   1. **Privy mode** (default): Reads `Authorization: Bearer <token>`,
 *      verifies the JWT against the Privy app, fetches the user, and pulls
 *      the linked Solana wallet out of `linkedAccounts`. With
 *      `walletChainType: 'solana-only'` on the client, the user can only
 *      have linked a Solana wallet, so this lookup is reliable.
 *
 *   2. **Dev-bypass mode**: When NEXT_PUBLIC_PRIVY_APP_ID is *unset* and
 *      NEXT_PUBLIC_DEV_WALLET *is* set, we skip Privy entirely and return
 *      the dev wallet for every request. The condition is intentionally
 *      asymmetric: a real Privy deployment that happens to have DEV_WALLET
 *      sitting in env (e.g. for ad-hoc scripts) must NOT silently bypass
 *      auth. The absence of an app id is what flips the switch.
 *
 * The Privy server client is lazily constructed so that dev-bypass mode
 * doesn't even instantiate it (and so module load doesn't crash if the
 * env vars are missing in non-Privy environments).
 */

import { PrivyClient } from '@privy-io/server-auth';

const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET;
const DEV_WALLET = process.env.NEXT_PUBLIC_DEV_WALLET;

/** Mirror of the client-side helper in src/app/privy-env.ts. */
export function isDevBypass(): boolean {
  return !PRIVY_APP_ID && !!DEV_WALLET;
}

let _privy: PrivyClient | null = null;
function privy(): PrivyClient {
  if (_privy) return _privy;
  if (!PRIVY_APP_ID || !PRIVY_APP_SECRET) {
    throw new Error(
      'Privy not configured: NEXT_PUBLIC_PRIVY_APP_ID and PRIVY_APP_SECRET must be set, or set NEXT_PUBLIC_DEV_WALLET for dev bypass.',
    );
  }
  _privy = new PrivyClient(PRIVY_APP_ID, PRIVY_APP_SECRET);
  return _privy;
}

/**
 * Resolve the connected Solana wallet from a Next.js Request.
 *
 * Returns null on any failure (missing/malformed header, expired token,
 * verification failure, no Solana wallet linked). The route wrapper
 * converts that into a 401 — we never throw from here so callers can use
 * a flat early-return pattern.
 */
export async function getAuthenticatedWallet(request: Request): Promise<string | null> {
  if (isDevBypass()) {
    return DEV_WALLET!;
  }

  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) return null;

  try {
    const claims = await privy().verifyAuthToken(token);
    // Use the deprecated DID-based getUser here (the typed-token variant
    // requires a separate id-token cookie which we don't surface). The
    // rate-limit caveat is acceptable for our scale; if it becomes a
    // problem we can switch to passing the id token through and using
    // getUser({idToken}) instead.
    const user = await privy().getUser(claims.userId);

    // walletChainType: 'solana-only' on the PrivyProvider config means the
    // only "wallet"-type linked account a user can have is a Solana one.
    // We still filter explicitly so a future config change can't silently
    // surface an Ethereum address as the resolved wallet.
    const solanaWallet = user.linkedAccounts.find(
      (a) => a.type === 'wallet' && (a as { chainType?: string }).chainType === 'solana',
    ) as { address: string } | undefined;

    return solanaWallet?.address ?? null;
  } catch {
    // Token verification or user lookup failed — treat as unauthenticated.
    return null;
  }
}
