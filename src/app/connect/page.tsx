'use client';

/**
 * /connect — landing/login page.
 *
 * Renders centred branding + a single "Connect Wallet" button. The button
 * routes through Privy's `useLogin` hook, which opens the wallet-connect
 * modal (configured for Solana-only by Providers). On success we forward
 * to /dashboard.
 *
 * Already-authenticated users hitting this page get bounced to /dashboard
 * immediately so the back button after a successful login doesn't dump
 * them on the login screen again.
 *
 * Dev-bypass mode (no PRIVY_APP_ID): Privy isn't mounted, so calling
 * useLogin would crash. We render a "Continue (dev mode)" button instead
 * that just navigates to /dashboard, where AppShell's bypass branch will
 * substitute the dev wallet.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { usePrivy, useLogin } from '@privy-io/react-auth';
import { isDevBypass } from '../privy-env';

export default function ConnectPage() {
  if (isDevBypass()) {
    return <DevBypassConnect />;
  }
  return <PrivyConnect />;
}

function PrivyConnect() {
  const router = useRouter();
  const { ready, authenticated } = usePrivy();
  const { login } = useLogin({
    onComplete: () => router.replace('/dashboard'),
  });

  // If the user lands here while already logged in, send them straight to
  // the dashboard. Done in an effect so router.push isn't called from
  // render.
  useEffect(() => {
    if (ready && authenticated) {
      router.replace('/dashboard');
    }
  }, [ready, authenticated, router]);

  return (
    <ConnectLayout>
      <button
        onClick={login}
        disabled={!ready}
        className="px-6 py-3 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-blue-900 disabled:text-blue-400 text-white font-medium text-sm transition-colors"
      >
        {ready ? 'Connect Wallet' : 'Loading…'}
      </button>
      <p className="text-xs text-[#6e7681] mt-4 max-w-xs text-center">
        Connect your Solana wallet to access your trade history and analytics.
        Read-only — Booba never signs transactions for you.
      </p>
    </ConnectLayout>
  );
}

function DevBypassConnect() {
  const router = useRouter();

  useEffect(() => {
    // In dev-bypass mode the user is always "authenticated" — just bounce.
    router.replace('/dashboard');
  }, [router]);

  return (
    <ConnectLayout>
      <p className="text-xs text-[#6e7681]">Dev mode — redirecting…</p>
    </ConnectLayout>
  );
}

function ConnectLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6">
      <div className="flex flex-col items-center max-w-md text-center">
        <h1 className="text-4xl font-bold text-white tracking-wider mb-2">BOOBAnalytics</h1>
        <p className="text-sm text-[#8b949e] mb-10">
          AI-powered trading journal for Pacifica
        </p>
        {children}
      </div>
    </div>
  );
}
