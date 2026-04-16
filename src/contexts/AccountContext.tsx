'use client';

/**
 * AccountContext — network (mainnet/testnet) and sub-account selection.
 *
 * Provides:
 *   - network: 'mainnet' | 'testnet' (persisted to localStorage)
 *   - setNetwork: switches network, clears sub-account state
 *   - subAccountId / setSubAccountId: active sub-account filter
 *   - subAccounts: loaded from Pacifica on mount and network change
 *   - pacificaApiUrl / pacificaWsUrl: derived from network
 *
 * Mount AccountProvider inside AuthedShell (AppShell.tsx) so it has
 * access to the wallet address for the sub-accounts fetch.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';

export type Network = 'mainnet' | 'testnet';

export interface SubAccount {
  id: string;
  label: string;
}

export interface AccountContextValue {
  network: Network;
  setNetwork: (n: Network) => void;
  subAccountId: string | null;
  setSubAccountId: (id: string | null) => void;
  subAccounts: SubAccount[];
  pacificaApiUrl: string;
  pacificaWsUrl: string;
}

const NETWORK_KEY = 'pacifica-network';

function getStoredNetwork(): Network {
  if (typeof window === 'undefined') return 'mainnet';
  const v = localStorage.getItem(NETWORK_KEY);
  return v === 'testnet' ? 'testnet' : 'mainnet';
}

function apiUrlFor(network: Network) {
  return network === 'testnet'
    ? 'https://test-api.pacifica.fi'
    : 'https://api.pacifica.fi';
}

function wsUrlFor(network: Network) {
  return network === 'testnet'
    ? 'wss://test-ws.pacifica.fi/ws'
    : 'wss://ws.pacifica.fi/ws';
}

const AccountContext = createContext<AccountContextValue | null>(null);

export function AccountProvider({
  walletAddress,
  children,
}: {
  walletAddress: string;
  children: React.ReactNode;
}) {
  const [network, setNetworkState] = useState<Network>(() => getStoredNetwork());
  const [subAccountId, setSubAccountId] = useState<string | null>(null);
  const [subAccounts, setSubAccounts] = useState<SubAccount[]>([]);

  const pacificaApiUrl = apiUrlFor(network);
  const pacificaWsUrl = wsUrlFor(network);

  const setNetwork = useCallback((n: Network) => {
    localStorage.setItem(NETWORK_KEY, n);
    setNetworkState(n);
    setSubAccountId(null);
    setSubAccounts([]);
  }, []);

  // Fetch sub-accounts when wallet or network changes.
  // The subaccounts endpoint only exists on testnet; skip on mainnet to avoid
  // a 404 that can't be suppressed from the browser console.
  // Pacifica exposes this as GET /api/v1/subaccounts?account=...
  useEffect(() => {
    if (!walletAddress) return;
    if (network === 'mainnet') {
      setSubAccounts([]);
      return;
    }
    let cancelled = false;

    fetch(
      `${pacificaApiUrl}/api/v1/subaccounts?account=${walletAddress}`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        // Handle different response shapes from Pacifica
        const raw: unknown[] = Array.isArray(data)
          ? data
          : Array.isArray(data?.subAccounts)
          ? data.subAccounts
          : [];
        const mapped = raw.map((sa: any) => ({
          id: String(sa.id ?? sa.subAccountId ?? sa.name ?? ''),
          label: String(sa.label ?? sa.name ?? sa.id ?? ''),
        })).filter((sa) => sa.id);
        setSubAccounts(mapped);
      })
      .catch(() => {
        if (!cancelled) setSubAccounts([]);
      });

    return () => {
      cancelled = true;
    };
  }, [pacificaApiUrl, walletAddress]);

  return (
    <AccountContext.Provider
      value={{
        network,
        setNetwork,
        subAccountId,
        setSubAccountId,
        subAccounts,
        pacificaApiUrl,
        pacificaWsUrl,
      }}
    >
      {children}
    </AccountContext.Provider>
  );
}

export function useAccount(): AccountContextValue {
  const ctx = useContext(AccountContext);
  if (!ctx) throw new Error('useAccount must be used within AccountProvider');
  return ctx;
}
