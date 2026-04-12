'use client';

/**
 * Providers — top-level client wrapper that mounts the Privy auth context.
 *
 * Lives directly inside the server <body> in layout.tsx, above AppShell.
 * AppShell consumes Privy state (usePrivy) to gate access to the rest of
 * the tree, so PrivyProvider must wrap it.
 *
 * Dev-bypass mode: when NEXT_PUBLIC_PRIVY_APP_ID is unset *and*
 * NEXT_PUBLIC_DEV_WALLET is set, we skip mounting PrivyProvider entirely
 * and just render children. AppShell detects the same condition and
 * substitutes the dev wallet for the would-be Privy user. This lets local
 * development (and Claude Code) work without Privy credentials.
 *
 * Reason for the condition (rather than always-on bypass when DEV_WALLET
 * is set): the user wants the *real* Privy flow to be the default whenever
 * the app is configured for it, with bypass only as a fallback for
 * environments that don't have credentials.
 */

import { PrivyProvider } from '@privy-io/react-auth';
import { toSolanaWalletConnectors } from '@privy-io/react-auth/solana';
import { isDevBypass, PRIVY_APP_ID } from './privy-env';

const solanaConnectors = toSolanaWalletConnectors();

export default function Providers({ children }: { children: React.ReactNode }) {
  if (isDevBypass()) {
    // No Privy mount in dev-bypass mode — AppShell will inject the dev wallet
    // straight into JournalProvider.
    return <>{children}</>;
  }

  return (
    <PrivyProvider
      appId={PRIVY_APP_ID!}
      config={{
        loginMethods: ['wallet'],
        appearance: {
          theme: 'dark',
          walletChainType: 'solana-only',
          showWalletLoginFirst: true,
        },
        externalWallets: {
          solana: { connectors: solanaConnectors },
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}