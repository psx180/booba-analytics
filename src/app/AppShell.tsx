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
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { JournalProvider } from './JournalContext';
import { LiveProvider } from './LiveContext';
import NavBar from './NavBar';
import { isDevBypass, DEV_WALLET } from './privy-env';
import { AccountProvider } from '@/contexts/AccountContext';
import { SyncProvider } from '@/contexts/SyncContext';
import IntroOverlay, { type IntroPhase } from './components/onboarding/IntroOverlay';
import IntroOverlayClassic from './components/onboarding/IntroOverlayClassic';
import ProductTour from './components/onboarding/ProductTour';

const USE_CINEMATIC_INTRO = true; // flip to false to revert to classic modal
import { BoobaProvider, useBooba } from './components/booba/BoobaContext';
import BoobaAvatar from './components/booba/BoobaAvatar';
import BoobaChat from './components/booba/BoobaChat';
import { GroupingProgressProvider } from './GroupingProgressContext';
import ProgressToast from './components/ProgressToast';

const CONNECT_PATH = '/connect';

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  // Manual-wallet cookie detection. `undefined` means "haven't checked yet"
  // — kept distinct from `null` ("checked, no cookie") so the first render
  // (which is identical on server and client) shows a neutral spinner and
  // avoids the hydration mismatch we'd get from reading `document.cookie`
  // during render. The effect then resolves us to a wallet or null.
  //
  // The `[pathname]` dep re-runs the effect on every route change so a
  // cookie set on /connect is picked up when we navigate to /dashboard
  // (AppShell doesn't unmount across route changes, so an empty dep array
  // would strand us with the stale null read from the /connect mount).
  //
  // The synchronous reset block below handles the race with
  // PrivyGatedShell: on the first render after navigation the effect
  // hasn't fired yet, so `manualWallet` still holds its stale value. If
  // that value is null we'd briefly render PrivyGatedShell, whose own
  // effect fires `router.replace(CONNECT_PATH)` before our effect can
  // correct the state. Resetting to `undefined` when leaving /connect
  // forces the spinner branch instead, keeping PrivyGatedShell from
  // mounting during the transition. We only reset on /connect → X
  // transitions (not every navigation) so Privy users don't see a
  // spinner flash on every page change.
  const [manualWallet, setManualWallet] = useState<string | null | undefined>(undefined);
  const [prevPathname, setPrevPathname] = useState<string>(pathname);
  if (prevPathname !== pathname) {
    if (prevPathname === CONNECT_PATH) {
      setManualWallet(undefined);
    }
    setPrevPathname(pathname);
  }
  useEffect(() => {
    const match = document.cookie.match(/manual-wallet=([A-Za-z0-9]{32,88})/);
    setManualWallet(match?.[1] ?? null);
  }, [pathname]);

  // Connect page is rendered raw (no nav, no journal context, no auth gate)
  // so the login button can fire freely.
  if (pathname === CONNECT_PATH) {
    return <>{children}</>;
  }

  if (isDevBypass()) {
    // Skip Privy entirely; the dev wallet is the authenticated wallet.
    return <AuthedShell walletAddress={DEV_WALLET!}>{children}</AuthedShell>;
  }

  // Still determining whether a manual-wallet cookie is present. This
  // only lasts from initial render → first effect tick, and matches the
  // spinner the Privy gate would show anyway, so no visible regression.
  if (manualWallet === undefined) {
    return <ShellSpinner label="Loading…" />;
  }

  // Manual wallet takes precedence over the Privy gate — mirrors the
  // precedence in auth.ts where the cookie is checked before the Privy
  // bearer token. Privy-authenticated users won't have this cookie set.
  if (manualWallet) {
    return <AuthedShell walletAddress={manualWallet}>{children}</AuthedShell>;
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
  // Cinematic flow runs as a small state machine:
  //   idle → intro (full overlay)
  //        → companion (Booba image stays put while ProductTour runs)
  //        → fading (image fades out after tour completes)
  //        → idle (overlay unmounts)
  // Classic flow only uses 'intro' / 'idle' — no companion handoff.
  const [introPhase, setIntroPhase] = useState<IntroPhase | 'idle'>('idle');
  const [showTour, setShowTour] = useState(false);

  // Analytics lifecycle state + poller. Hoisted here (rather than inside a
  // hook) so we can expose an optimistic setter via context: the Import
  // button on the dashboard calls it the instant it fires POST /api/import,
  // so the nav-lock + banner engage immediately instead of waiting up to
  // 30 s for the next poll tick to observe the server-side flip.
  const analyticsPoller = useAnalyticsStatusState();
  const { status: analyticsStatus, setOptimisticStatus } = analyticsPoller;

  const pathname = usePathname();
  const router = useRouter();

  // Lock the user onto /dashboard while an import is running. /import is
  // allow-listed as a forward-compat guard in case onboarding ever splits
  // into its own route — today no such route exists, but keeping the check
  // means we don't have to remember to add it later.
  useEffect(() => {
    if (
      analyticsStatus === 'importing'
      && pathname
      && !pathname.startsWith('/dashboard')
      && !pathname.startsWith('/import')
    ) {
      router.replace('/dashboard');
    }
  }, [analyticsStatus, pathname, router]);

  useEffect(() => {
    if (!localStorage.getItem('hasSeenAppIntro')) {
      setIntroPhase('intro');
    }
  }, []);

  const navDisabled = analyticsStatus === 'importing';

  return (
    <AnalyticsStatusContext.Provider value={{ setOptimisticStatus }}>
    <AccountProvider walletAddress={walletAddress}>
      <JournalProvider walletAddress={walletAddress}>
        <LiveProvider>
          <SyncProvider>
            <BoobaProvider>
              <GroupingProgressProvider>
                <NavBar navDisabled={navDisabled} />
                {analyticsStatus === 'importing' && <ImportingBanner />}
                {analyticsStatus === 'computing' && <SlowAnalyticsBanner />}
                <main className="max-w-[1400px] mx-auto px-4 py-4">{children}</main>
                <footer className="text-center text-[10px] text-[#484f58] py-4 font-mono">
                  Built on Pacifica                </footer>
                {USE_CINEMATIC_INTRO && introPhase !== 'idle' && (
                  <IntroOverlay
                    phase={introPhase}
                    onDismiss={() => {
                      setIntroPhase('companion');
                      setShowTour(true);
                    }}
                    onFadeComplete={() => setIntroPhase('idle')}
                  />
                )}
                {!USE_CINEMATIC_INTRO && introPhase === 'intro' && (
                  <IntroOverlayClassic
                    onStartTour={() => {
                      setIntroPhase('idle');
                      setShowTour(true);
                    }}
                    onSkip={() => {
                      setIntroPhase('idle');
                      localStorage.setItem('hasSeenAppIntro', 'true');
                    }}
                  />
                )}
                {showTour && (
                  <ProductTour
                    onComplete={() => {
                      setShowTour(false);
                      // Cinematic flow holds Booba on-screen during the tour;
                      // trigger the fade-out only after the tour finishes.
                      if (USE_CINEMATIC_INTRO) setIntroPhase('fading');
                    }}
                  />
                )}
                <BoobaShellLayer />
                <ProgressToast />
              </GroupingProgressProvider>
            </BoobaProvider>
          </SyncProvider>
        </LiveProvider>
      </JournalProvider>
    </AccountProvider>
    </AnalyticsStatusContext.Provider>
  );
}

// ── Booba shell layer ────────────────────────────────────────────────────────
// Renders BoobaAvatar + BoobaChat globally. Contextual messages are derived
// from the current pathname; dynamic state (health score, insight) is pushed
// here by individual page components via BoobaContext.setBoobaState.

function BoobaShellLayer() {
  const pathname = usePathname();
  const router = useRouter();
  const { healthScore, insight, insightMood, insightLink, chatOpen, prefillMessage, openChat, closeChat } = useBooba();

  // Per-page static fallback messages (shown when no dynamic insight is set)
  const staticInsight = useMemo((): string | null => {
    if (pathname?.startsWith('/trades')) return 'Click any trade to see details';
    if (pathname?.startsWith('/analytics')) return 'Check the tabs for deep analysis';
    if (pathname?.startsWith('/signals')) return 'Your best caller is shown at the top';
    if (pathname?.startsWith('/playbooks')) return "Define your rules and I'll check every trade";
    return null; // /dashboard (comes from context) and /settings (silent)
  }, [pathname]);

  const isDashboard = pathname === '/dashboard';
  // On dashboard, context.insight is the fully-computed message from DashboardClient.
  // On other pages, context.insight is cleared on mount by the page component;
  // use it for dynamic overrides (e.g. trade annotations) and fall back to static.
  const effectiveInsight = chatOpen
    ? null
    : isDashboard
      ? insight
      : (insight ?? staticInsight);

  const effectiveInsightLink = isDashboard ? insightLink : null;
  // Only propagate the context mood when we're actually using the context insight (not staticInsight)
  const effectiveInsightMood = chatOpen ? null : (isDashboard || insight) ? insightMood : null;

  return (
    <>
      <BoobaChat
        isOpen={chatOpen}
        onClose={closeChat}
        prefillMessage={prefillMessage}
      />
      <BoobaAvatar
        healthScore={healthScore}
        insight={effectiveInsight}
        insightMood={effectiveInsightMood}
        onInsightClick={effectiveInsightLink ? () => router.push(effectiveInsightLink) : undefined}
        onChatToggle={() => (chatOpen ? closeChat() : openChat())}
        chatOpen={chatOpen}
      />
    </>
  );
}

function ShellSpinner({ label }: { label: string }) {
  return (
    <>
      <div className="border-b border-[#21262d] bg-[#161b22] h-12" />
      <main className="max-w-[1400px] mx-auto px-4 py-4">
        <div className="flex items-center justify-center text-[#6e7681] text-sm h-64">
          {label}
        </div>
      </main>
    </>
  );
}

// ── Analytics status poller + optimistic-update context ────────────────────
//
// Lifecycle the UI cares about:
//   null        → wallet has no Journal rows (pre-import) or hasn't been
//                 polled yet. Poll cheaply.
//   'importing' → /api/import handler is pulling trades from Pacifica.
//                 NavBar is locked, non-dashboard routes redirect home.
//   'computing' → fast tier is done, slow tier (MFE/MAE + regime tagging)
//                 is running in the background.
//   'ready'     → everything populated; steady state.
//
// The poller talks to /api/analytics/status. Cadence is adaptive so active
// states refresh quickly but idle ones don't hammer the server. The
// optimistic setter exists so the Import button can flip local state to
// 'importing' at click-time, closing the race where the next server-side
// poll might be 30 s away.

const POLL_INTERVAL_ACTIVE_MS = 5_000;
const POLL_INTERVAL_IDLE_MS = 30_000;

interface AnalyticsStatusContextValue {
  setOptimisticStatus: (next: string) => void;
}

const AnalyticsStatusContext = createContext<AnalyticsStatusContextValue | null>(null);

/**
 * Optimistic-update hook used by callers that kick off state transitions
 * (currently: the dashboard's Import button). Returns null when rendered
 * outside the AuthedShell tree so the connect page can import it without
 * crashing.
 */
export function useAnalyticsStatusSetter(): ((next: string) => void) | null {
  const ctx = useContext(AnalyticsStatusContext);
  return ctx?.setOptimisticStatus ?? null;
}

function useAnalyticsStatusState(): {
  status: string | null;
  setOptimisticStatus: (next: string) => void;
} {
  const [status, setStatus] = useState<string | null>(null);
  const prevStatusRef = useRef<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const tick = async () => {
      try {
        const res = await fetch('/api/analytics/status', { cache: 'no-store' });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data: { status?: string | null } = await res.json();
        const next = data?.status ?? null;

        if (cancelled) return;

        // Reload when we observe the computing → ready transition so
        // downstream pages pick up the newly-available slow-tier data.
        if (prevStatusRef.current === 'computing' && next === 'ready') {
          window.location.reload();
          return;
        }
        prevStatusRef.current = next;
        setStatus(next);

        const delay = (next === 'importing' || next === 'computing')
          ? POLL_INTERVAL_ACTIVE_MS
          : POLL_INTERVAL_IDLE_MS;
        timer = setTimeout(tick, delay);
      } catch {
        // Network blip / 5xx — keep polling at the idle cadence so we
        // recover without spinning. Never throw out of the poller.
        if (!cancelled) timer = setTimeout(tick, POLL_INTERVAL_IDLE_MS);
      }
    };

    tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Optimistic setter — bumps local state without waiting for a poll
  // round-trip. prevStatusRef is updated too so we don't mis-detect a
  // computing→ready transition as a result of the optimistic bump.
  const setOptimisticStatus = useCallback((next: string) => {
    prevStatusRef.current = next;
    setStatus(next);
  }, []);

  return { status, setOptimisticStatus };
}

function SlowAnalyticsBanner() {
  return (
    <div className="bg-amber-600 text-white text-sm font-medium px-4 py-3 text-center sticky top-12 z-40 shadow-md">
      <div className="max-w-[1400px] mx-auto flex items-center justify-center gap-3">
        <svg
          className="animate-spin h-4 w-4 flex-shrink-0"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <span>
          Deep analytics computing — regime detection, exit quality analysis, and risk metrics.
          This takes a few minutes. You can explore, but some features will populate as computation completes.
        </span>
      </div>
    </div>
  );
}

function ImportingBanner() {
  return (
    <div className="bg-blue-600 text-white text-sm font-medium px-4 py-3 text-center sticky top-12 z-40 shadow-md">
      <div className="max-w-[1400px] mx-auto flex items-center justify-center gap-3">
        <svg
          className="animate-spin h-4 w-4 flex-shrink-0"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <span>
          Importing your trade history from Pacifica. This may take several minutes. Please don&apos;t close this tab.
        </span>
      </div>
    </div>
  );
}
