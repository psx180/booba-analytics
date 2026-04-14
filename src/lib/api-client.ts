'use client';

/**
 * api-client.ts — authenticated fetch wrapper for the browser.
 *
 * Every component that calls our API routes should use `useAuthFetch()`
 * instead of `fetch()`. The hook returns an async function with the exact
 * same signature as `fetch` (URL + RequestInit), but automatically injects
 * the `Authorization: Bearer <token>` header from the Privy session.
 *
 * Dev-bypass mode: when the Privy provider isn't mounted (NEXT_PUBLIC_DEV_WALLET
 * is set, NEXT_PUBLIC_PRIVY_APP_ID is unset), `getAccessToken` isn't
 * available — the returned fetch wrapper sends requests without any auth
 * header. The server-side `getAuthenticatedWallet` independently detects
 * dev-bypass mode and returns the dev wallet, so the round trip still works.
 *
 * Usage:
 *
 *   const authFetch = useAuthFetch();
 *   const res = await authFetch('/api/trade-units?pageSize=50');
 */

import { useCallback, useRef } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { isDevBypass } from '../app/privy-env';

/**
 * Returns an authenticated fetch function. Stable across re-renders as
 * long as the Privy session doesn't change (uses a ref to avoid
 * re-creating the closure on every render).
 */
export function useAuthFetch(): typeof fetch {
  const devBypass = isDevBypass();
  // In dev-bypass mode, Privy isn't mounted, so calling usePrivy() would
  // throw. We guard against that by returning a plain fetch wrapper early.
  // React hooks must be called unconditionally, but the function body below
  // the early-return never runs — the hook's callsite count is stable
  // because isDevBypass() is a compile-time constant (NEXT_PUBLIC_* vars
  // are inlined by Next.js at build time).

  // We use a ref + non-conditional hooks pattern. Even in dev bypass mode
  // we define the ref so hook order doesn't change.
  const getTokenRef = useRef<(() => Promise<string | null>) | null>(null);

  if (!devBypass) {
    // Safe to call usePrivy when PrivyProvider is mounted.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const { getAccessToken } = usePrivy();
    getTokenRef.current = getAccessToken;
  }

  const authFetch = useCallback(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (devBypass) {
        // No auth header in dev-bypass mode — server detects it.
        return fetch(input, init);
      }

      const token = await getTokenRef.current?.();
      const headers = new Headers(init?.headers);
      if (token) {
        headers.set('Authorization', `Bearer ${token}`);
      }
      if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }
      // Forward the selected network so server-side Pacifica client can use it.
      const network =
        typeof window !== 'undefined'
          ? (localStorage.getItem('pacifica-network') ?? 'mainnet')
          : 'mainnet';
      headers.set('X-Pacifica-Network', network);
      return fetch(input, { ...init, headers });
    },
    [devBypass],
  );

  return authFetch as typeof fetch;
}
