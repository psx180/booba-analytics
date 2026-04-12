/**
 * privy-env — single source of truth for "is Privy configured, or are we
 * running in dev-bypass mode?". Imported by both Providers (client) and
 * AppShell (client). The server-side equivalent lives in src/lib/auth.ts.
 *
 * NEXT_PUBLIC_* vars are inlined at build time, so this file is safe to
 * import from any client component.
 */

export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
export const DEV_WALLET = process.env.NEXT_PUBLIC_DEV_WALLET;

/**
 * Dev bypass is active when there's no Privy app id but a dev wallet is
 * set. The "spec" condition explicitly requires the absence of an app id
 * — we don't auto-bypass just because DEV_WALLET happens to be present,
 * because real Privy deployments often want a dev wallet around for other
 * scripts.
 */
export function isDevBypass(): boolean {
  return !PRIVY_APP_ID && !!DEV_WALLET;
}
