'use client';

/**
 * /connect — landing/login page.
 *
 * Three-tier funnel:
 *   1. Try Demo — sets the manual-wallet cookie to a known demo address and
 *      bounces to /dashboard so a visitor can explore real analytics in one
 *      click.
 *   2. Generate Report — paste any Pacifica wallet, validate, redirect to
 *      /report?wallet=…  for a public PDF-report flow (no auth needed).
 *   3. Connect Wallet / manual entry — existing Privy login + manual wallet
 *      entry, kept for users who want the full interactive experience.
 *
 * Already-authenticated users hitting this page get bounced to /dashboard
 * immediately so the back button after a successful login doesn't dump them
 * on the login screen again.
 *
 * Dev-bypass mode (no PRIVY_APP_ID): Privy isn't mounted, so calling
 * useLogin would crash. We skip the Privy hook in that branch and just
 * bounce to /dashboard, where AppShell's bypass branch substitutes the dev
 * wallet.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePrivy, useLogin } from '@privy-io/react-auth';
import { isDevBypass } from '../privy-env';

// Demo wallet is supplied via NEXT_PUBLIC_DEMO_WALLET. When the env var is
// missing or malformed the Try Demo tier is hidden entirely — we never ship
// a hardcoded fallback in source.
const DEMO_WALLET = process.env.NEXT_PUBLIC_DEMO_WALLET;
const HAS_DEMO = !!DEMO_WALLET && /^[A-Za-z0-9]{32,88}$/.test(DEMO_WALLET);

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

  useEffect(() => {
    if (ready && authenticated) {
      router.replace('/dashboard');
    }
  }, [ready, authenticated, router]);

  return (
    <ConnectLayout>
      {HAS_DEMO && (
        <>
          <DemoTier wallet={DEMO_WALLET as string} />
          <Divider />
        </>
      )}
      <GenerateReportTier />
      <Divider />
      <WalletConnectTier ready={ready} onLogin={login} />
    </ConnectLayout>
  );
}

function DevBypassConnect() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/dashboard');
  }, [router]);

  return (
    <ConnectLayout>
      <p className="text-xs text-[#6e7681]">Dev mode — redirecting…</p>
    </ConnectLayout>
  );
}

// ─── Tier 1: Try Demo ───────────────────────────────────────────────────────

function DemoTier({ wallet }: { wallet: string }) {
  const router = useRouter();
  const tryDemo = () => {
    document.cookie = `manual-wallet=${wallet}; path=/; max-age=86400`;
    router.replace('/dashboard');
  };

  return (
    <div className="flex flex-col items-center w-full max-w-sm">
      <button
        onClick={tryDemo}
        className="w-full px-6 py-4 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold text-base transition-colors shadow-lg shadow-blue-600/20"
      >
        Try Demo — Explore Real Analytics
      </button>
      <p className="text-xs text-[#8b949e] mt-3 text-center">
        Pre-loaded with real data. One click.
      </p>
    </div>
  );
}

// ─── Tier 2: Generate Report ────────────────────────────────────────────────

function GenerateReportTier() {
  const router = useRouter();
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const trimmed = address.trim();
    if (!/^[A-Za-z0-9]{32,88}$/.test(trimmed)) {
      setError('Enter a valid Pacifica wallet address (32–88 alphanumeric characters).');
      return;
    }
    router.push(`/report?wallet=${encodeURIComponent(trimmed)}`);
  };

  return (
    <div className="flex flex-col items-center w-full max-w-sm">
      <h2 className="text-lg font-semibold text-white mb-1">Generate a Report</h2>
      <p className="text-xs text-[#8b949e] mb-4 text-center">
        Get a full analytics report for any Pacifica wallet.
      </p>
      <div className="flex w-full gap-2">
        <input
          type="text"
          value={address}
          onChange={(e) => { setAddress(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          placeholder="Enter wallet address"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="flex-1 min-w-0 px-3 py-2.5 rounded-md bg-[#0d1117] border border-[#30363d] text-sm text-white placeholder-[#484f58] focus:border-[#58a6ff] focus:outline-none transition-colors"
        />
        <button
          onClick={submit}
          className="px-4 py-2.5 rounded-md bg-[#21262d] hover:bg-[#30363d] border border-[#30363d] hover:border-[#58a6ff] text-sm text-white font-medium transition-colors whitespace-nowrap"
        >
          Generate PDF
        </button>
      </div>
      {error && (
        <p className="text-[11px] text-red-400 mt-2 self-start">{error}</p>
      )}
      <p className="text-[11px] text-[#6e7681] mt-2 text-center">
        No account needed. Takes a few minutes for new wallets.
      </p>
    </div>
  );
}

// ─── Tier 3: Wallet Connect / Manual Entry ──────────────────────────────────

function WalletConnectTier({ ready, onLogin }: { ready: boolean; onLogin: () => void }) {
  return (
    <div className="flex flex-col items-center w-full max-w-sm">
      <p className="text-xs text-[#8b949e] mb-3 text-center">
        For the full interactive experience
      </p>
      <button
        onClick={onLogin}
        disabled={!ready}
        className="px-5 py-2.5 rounded-md border border-[#30363d] hover:border-[#58a6ff] disabled:border-[#21262d] disabled:text-[#484f58] text-sm text-[#c9d1d9] font-medium transition-colors"
      >
        {ready ? 'Connect Wallet' : 'Loading…'}
      </button>
      <p className="text-[11px] text-[#6e7681] mt-3 text-center max-w-xs">
        Read-only — Booba never signs transactions for you.
      </p>
      <ManualWalletEntry />
    </div>
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
    <div className="flex flex-col items-center mt-5 w-full">
      <p className="text-[11px] text-[#6e7681] mb-2 text-center">
        Or explore without connecting:
      </p>
      <div className="flex w-full gap-2">
        <input
          type="text"
          value={address}
          onChange={(e) => { setAddress(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          placeholder="Wallet address"
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
    </div>
  );
}

// ─── Layout helpers ─────────────────────────────────────────────────────────

function Divider() {
  return (
    <div className="flex items-center w-full max-w-sm my-8 text-[10px] uppercase tracking-widest text-[#6e7681]">
      <span className="flex-1 h-px bg-[#30363d]" />
      <span className="px-3">or</span>
      <span className="flex-1 h-px bg-[#30363d]" />
    </div>
  );
}

function ConnectLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 py-12">
      <div className="flex flex-col items-center max-w-md w-full text-center">
        <h1 className="text-4xl font-bold text-white tracking-wider mb-2">BOOBAnalytics</h1>
        <p className="text-sm text-[#8b949e] mb-10">
          AI-powered trading journal for Pacifica
        </p>
        {children}
      </div>
    </div>
  );
}
