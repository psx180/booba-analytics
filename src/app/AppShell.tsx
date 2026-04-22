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
import { useEffect, useMemo, useState } from 'react';
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
  // during render. The effect then resolves us to a wallet or null, and the
  // next render branches accordingly.
  const [manualWallet, setManualWallet] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const match = document.cookie.match(/manual-wallet=([A-Za-z0-9]{32,88})/);
    setManualWallet(match?.[1] ?? null);
  }, []);

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

  useEffect(() => {
    if (!localStorage.getItem('hasSeenAppIntro')) {
      setIntroPhase('intro');
    }
  }, []);

  return (
    <AccountProvider walletAddress={walletAddress}>
      <JournalProvider walletAddress={walletAddress}>
        <LiveProvider>
          <SyncProvider>
            <BoobaProvider>
              <GroupingProgressProvider>
                <NavBar />
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
