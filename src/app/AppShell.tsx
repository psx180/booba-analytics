'use client';

/**
 * AppShell — auth gate + journal-provider mount + chrome (NavBar).
 *
 * Three modes:
 *
 *   1. **Connect page** (`/connect`): rendered with no auth gate and no
 *      JournalProvider, so the page can call usePrivy().login() without
 *      being trapped behind its own redirect.
 *
 *   2. **Real Privy mode** (default): we read auth state from usePrivy().
 *      While Privy is initialising → show a centred spinner.
 *      Authenticated → extract the connected Solana wallet address from
 *      `user.wallet.address`, mount JournalProvider, render the NavBar +
 *      page children.
 *      Unauthenticated → redirect to /connect.
 *
 *   3. **Dev-bypass mode** (NEXT_PUBLIC_PRIVY_APP_ID unset, DEV_WALLET set):
 *      Privy isn't mounted at all. We treat the dev wallet as the
 *      authenticated wallet and render the rest of the tree directly. The
 *      NavBar suppresses the disconnect button in this mode.
 *
 * Why the connect page is special-cased rather than letting it short-circuit
 * itself: server-rendered pages mount AppShell *before* their own client
 * code runs. If AppShell did `if (!authenticated) router.push('/connect')`
 * unconditionally, navigating to /connect while logged out would still
 * fire the redirect (a no-op, but the gate would also try to mount
 * JournalProvider with no wallet, throwing). Skipping the gate when
 * pathname === '/connect' is the cleanest fix.
 */

import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { JournalProvider } from './JournalContext';
import { LiveProvider } from './LiveContext';
import NavBar from './NavBar';
import { isDevBypass, DEV_WALLET } from './privy-env';
import { AccountProvider } from '@/contexts/AccountContext';

const CONNECT_PATH = '/connect';

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  // Connect page is rendered raw (no nav, no journal context, no auth gate)
  // so the login button can fire freely.
  if (pathname === CONNECT_PATH) {
    return <>{children}</>;
  }

  if (isDevBypass()) {
    // Skip Privy entirely; the dev wallet is the authenticated wallet.
    return <AuthedShell walletAddress={DEV_WALLET!}>{children}</AuthedShell>;
  }

  return <PrivyGatedShell>{children}</PrivyGatedShell>;
}

// ── Privy auth gate ─────────────────────────────────────────────────────────

function PrivyGatedShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { ready, authenticated, user } = usePrivy();

  // Kick the user to /connect once Privy has finished initialising and we
  // can confirm there's no session. Doing this in an effect (rather than
  // calling router.push during render) keeps the redirect off the render
  // path and avoids "navigated during render" warnings.
  useEffect(() => {
    if (ready && !authenticated) {
      router.replace(CONNECT_PATH);
    }
  }, [ready, authenticated, router]);

  if (!ready) {
    return <ShellSpinner label="Loading…" />;
  }

  if (!authenticated) {
    // Redirect already fired; render the spinner so the page doesn't flash
    // an empty layout while Next.js navigates.
    return <ShellSpinner label="Redirecting…" />;
  }

  // walletChainType: 'solana-only' on PrivyProvider guarantees the primary
  // user.wallet (when present) is a Solana wallet, so we don't have to
  // walk linkedAccounts here.
  const walletAddress = user?.wallet?.address;
  if (!walletAddress) {
    // Authenticated but no wallet on record yet — Privy is still hydrating
    // the user object. Show the spinner; the next render will catch up.
    return <ShellSpinner label="Connecting wallet…" />;
  }

  return <AuthedShell walletAddress={walletAddress}>{children}</AuthedShell>;
}

// ── Mounted shell ───────────────────────────────────────────────────────────

function AuthedShell({
  walletAddress,
  children,
}: {
  walletAddress: string;
  children: React.ReactNode;
}) {
  return (
    <AccountProvider walletAddress={walletAddress}>
      <JournalProvider walletAddress={walletAddress}>
        <LiveProvider>
          <NavBar />
          <main className="max-w-[1400px] mx-auto px-4 py-6">{children}</main>
        </LiveProvider>
      </JournalProvider>
    </AccountProvider>
  );
}

function ShellSpinner({ label }: { label: string }) {
  return (
    <>
      <div className="border-b border-[#21262d] bg-[#161b22] h-12" />
      <main className="max-w-[1400px] mx-auto px-4 py-6">
        <div className="flex items-center justify-center text-[#6e7681] text-sm h-64">
          {label}
        </div>
      </main>
    </>
  );
}
