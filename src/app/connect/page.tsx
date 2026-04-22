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

import { useEffect, useState } from 'react';
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
      <ManualWalletEntry />
    </ConnectLayout>
  );
}

function ManualWalletEntry() {
  const router = useRouter();
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const trimmed = address.trim();
    if (!/^[A-Za-z0-9]{32,88}$/.test(trimmed)) {
      setError('Enter a valid Solana wallet address (32–88 alphanumeric characters).');
      return;
    }
    document.cookie = `manual-wallet=${trimmed}; path=/; max-age=86400`;
    router.replace('/dashboard');
  };

  return (
    <div className="flex flex-col items-center mt-10 w-full max-w-xs">
      <div className="flex items-center w-full text-[10px] uppercase tracking-widest text-[#6e7681] mb-4">
        <span className="flex-1 h-px bg-[#30363d]" />
        <span className="px-3">or</span>
        <span className="flex-1 h-px bg-[#30363d]" />
      </div>
      <label className="text-xs text-[#8b949e] mb-2 self-start">
        Enter your Pacifica wallet address
      </label>
      <div className="flex w-full gap-2">
        <input
          type="text"
          value={address}
          onChange={(e) => { setAddress(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          placeholder="e.g. 7xKX...pump"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="flex-1 min-w-0 px-3 py-2 rounded-md bg-[#0d1117] border border-[#30363d] text-xs text-white placeholder-[#484f58] focus:border-[#58a6ff] focus:outline-none transition-colors"
        />
        <button
          onClick={submit}
          className="px-3 py-2 rounded-md border border-[#30363d] hover:border-[#58a6ff] text-xs text-[#c9d1d9] transition-colors"
        >
          Explore
        </button>
      </div>
      {error && (
        <p className="text-[11px] text-red-400 mt-2 self-start">{error}</p>
      )}
      <p className="text-[11px] text-[#6e7681] mt-2 text-center">
        Explore your public trade history without connecting a wallet. Some
        features may be limited.
      </p>
    </div>
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
