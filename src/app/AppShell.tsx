'use client';

/**
 * AppShell — client-side root that owns wallet resolution and the
 * JournalProvider. Mounted in the server layout so every page gets:
 *   • a journal context the dashboard/trades/analytics clients can read
 *   • the top NavBar (which includes the JournalSelector)
 *
 * Wallet resolution: read ?wallet= off the URL, fall back to the dev
 * default. The wallet flows through useSearchParams so that switching the
 * URL re-mounts the provider with a fresh wallet automatically.
 *
 * The Suspense boundary is required by Next.js because useSearchParams
 * bails out of static prerendering. The fallback intentionally does NOT
 * render `children` — if it did, server-rendered pages would mount the
 * dashboard/trades/analytics clients *outside* the JournalProvider and
 * `useJournal()` would throw on every initial paint. Instead, the fallback
 * renders an empty layout shell and the real tree (provider + children)
 * comes in once the boundary resumes.
 */

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { JournalProvider } from './JournalContext';
import NavBar from './NavBar';

const DEV_FALLBACK_WALLET = '32K2iNzqyFTfahrascrWni9tnp7kkmHcUSVkTzKpAGZk';

function ShellInner({ children }: { children: React.ReactNode }) {
  const sp = useSearchParams();
  const walletAddress = sp.get('wallet') ?? DEV_FALLBACK_WALLET;

  return (
    <JournalProvider walletAddress={walletAddress}>
      <NavBar />
      <main className="max-w-[1400px] mx-auto px-4 py-6">{children}</main>
    </JournalProvider>
  );
}

function ShellFallback() {
  // Empty layout shell — no children, no provider — used only while
  // Suspense waits for useSearchParams. Hydration replaces this with
  // ShellInner above.
  return (
    <>
      <div className="border-b border-[#21262d] bg-[#161b22] h-12" />
      <main className="max-w-[1400px] mx-auto px-4 py-6" />
    </>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<ShellFallback />}>
      <ShellInner>{children}</ShellInner>
    </Suspense>
  );
}
