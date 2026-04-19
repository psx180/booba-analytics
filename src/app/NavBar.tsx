'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { usePrivy, useLogout } from '@privy-io/react-auth';
import { useRef, useEffect, useState, useCallback } from 'react';
import { useJournal, useJournalOptional } from './JournalContext';
import { useLive } from './LiveContext';
import { useSync } from '@/contexts/SyncContext';
import { isDevBypass } from './privy-env';
import JournalSelector from './JournalSelector';
import { useAccount, type Network } from '@/contexts/AccountContext';
import { useAuthFetch } from '@/lib/api-client';

const tabs: { href: string; label: string; tourId?: string; disabled?: boolean }[] = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/trades', label: 'Trades', tourId: 'nav-trades' },
  { href: '/analytics', label: 'Analytics', tourId: 'nav-analytics' },
  { href: '/signals', label: 'Signals', tourId: 'nav-signals' },
  { href: '/playbooks', label: 'Playbooks', tourId: 'nav-playbooks' },
  { href: '/settings', label: 'Settings' },
];

function truncate(addr: string): string {
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

export default function NavBar() {
  const pathname = usePathname();
  const { network } = useAccount();
  const isTestnet = network === 'testnet';

  return (
    <>
      <nav className="border-b border-[#21262d] bg-[#161b22]">
        <div className="max-w-[1400px] mx-auto px-4">
          <div className="flex items-center gap-1 h-12">
            <span className="text-sm font-bold text-white mr-4 tracking-wider">BOOBAnalytics</span>
            {tabs.map((tab) => {
              const isActive = !tab.disabled && pathname.startsWith(tab.href);
              return tab.disabled ? (
                <span
                  key={tab.label}
                  className="px-4 py-2 text-sm text-[#6e7681] cursor-not-allowed select-none"
                >
                  {tab.label}
                </span>
              ) : (
                <Link
                  key={tab.href}
                  href={tab.href}
                  data-tour={(tab as { tourId?: string }).tourId}
                  className={`px-4 py-2 text-sm transition-colors ${
                    isActive
                      ? 'text-white border-b-2 border-blue-400 -mb-px'
                      : 'text-[#8b949e] hover:text-white'
                  }`}
                >
                  {tab.label}
                </Link>
              );
            })}
            {/* Right edge: network → sub-account → journal → wallet */}
            <div className="ml-auto flex items-center gap-2">
              <LiveIndicator />
              <SyncButton />
              <NetworkSelector />
              <SubAccountSelector />
              <JournalSelector />
              <WalletBadge />
            </div>
          </div>
        </div>
      </nav>
      {isTestnet && (
        <div className="bg-orange-500/15 border-b border-orange-500/40 text-orange-200 text-xs px-4 py-1.5 text-center">
          Testnet mode — trades and data are routed to your Testnet journal.
        </div>
      )}
    </>
  );
}

// ── Network selector ───────────────────────────────────────────────────────

const LAST_MAINNET_JOURNAL_KEY = 'lastMainnetJournal';

function NetworkSelector() {
  const { network, setNetwork } = useAccount();
  const journal = useJournalOptional();
  const authFetch = useAuthFetch();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleSwitch = useCallback(async (n: Network) => {
    if (n === network) { setOpen(false); return; }
    setSwitching(true);
    try {
      if (n === 'testnet' && journal) {
        // Save the current journal so we can restore it on mainnet switch
        if (journal.journalId) {
          localStorage.setItem(LAST_MAINNET_JOURNAL_KEY, journal.journalId);
        }
        // Find or create the Testnet journal
        let testnetJournal = journal.journals.find((j) => j.name === 'Testnet');
        if (!testnetJournal) {
          const res = await authFetch('/api/journals', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Testnet' }),
          });
          if (res.ok) {
            const data = await res.json();
            await journal.refresh();
            testnetJournal = (data as { journal?: { id: string; name: string } }).journal as any;
          }
        } else {
          // Refresh list in case it changed
          await journal.refresh();
          testnetJournal = journal.journals.find((j) => j.name === 'Testnet');
        }
        if (testnetJournal?.id) {
          journal.setJournalId(testnetJournal.id);
        }
      } else if (n === 'mainnet' && journal) {
        // Restore previously-active mainnet journal
        const prev = localStorage.getItem(LAST_MAINNET_JOURNAL_KEY);
        if (prev && journal.journals.some((j) => j.id === prev)) {
          journal.setJournalId(prev);
        } else {
          const def = journal.journals.find((j) => j.isDefault);
          if (def) journal.setJournalId(def.id);
        }
      }
    } catch {
      // Journal switch failed — still switch the network
    } finally {
      setSwitching(false);
    }
    setNetwork(n);
    setOpen(false);
  }, [network, journal, authFetch, setNetwork]);

  const isTestnet = network === 'testnet';

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={switching}
        data-tour="network-switcher"
        className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-[#21262d] hover:bg-[#30363d] border border-[#30363d] text-[#e6edf3] transition-colors disabled:opacity-60"
        title="Switch network"
      >
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${
            isTestnet ? 'bg-orange-400' : 'bg-green-400'
          }`}
        />
        {switching ? '…' : isTestnet ? 'Testnet' : 'Mainnet'}
        <span className="text-[10px] text-[#6e7681]">▾</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 bg-[#1c2128] border border-[#30363d] rounded shadow-xl z-30 min-w-[140px]">
          {(['mainnet', 'testnet'] as Network[]).map((n) => (
            <button
              key={n}
              onClick={() => handleSwitch(n)}
              className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 transition-colors ${
                network === n
                  ? 'bg-blue-900/30 text-white'
                  : 'text-[#e6edf3] hover:bg-[#21262d]'
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  n === 'testnet' ? 'bg-orange-400' : 'bg-green-400'
                }`}
              />
              {n === 'mainnet' ? 'Mainnet' : 'Testnet'}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Sub-account selector ────────────────────────────────────────────────────

function SubAccountSelector() {
  const { subAccounts, subAccountId, setSubAccountId } = useAccount();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Only render when sub-accounts exist (after hooks — Rules of Hooks)
  if (subAccounts.length === 0) return null;

  const activeLabel =
    subAccountId == null
      ? 'Main Account'
      : (subAccounts.find((sa) => sa.id === subAccountId)?.label ?? subAccountId);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium bg-[#21262d] hover:bg-[#30363d] text-[#e6edf3] border border-[#30363d] transition-colors"
        title="Switch sub-account"
      >
        <span className="text-[#6e7681] uppercase tracking-widest text-[9px]">Account</span>
        <span className="text-white max-w-[120px] truncate">{activeLabel}</span>
        <span className="text-[10px] text-[#6e7681]">▾</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 bg-[#1c2128] border border-[#30363d] rounded shadow-xl z-30 min-w-[180px]">
          <button
            onClick={() => { setSubAccountId(null); setOpen(false); }}
            className={`w-full text-left px-3 py-2 text-xs transition-colors ${
              subAccountId == null
                ? 'bg-blue-900/30 text-white'
                : 'text-[#e6edf3] hover:bg-[#21262d]'
            }`}
          >
            Main Account
          </button>
          {subAccounts.map((sa) => (
            <button
              key={sa.id}
              onClick={() => { setSubAccountId(sa.id); setOpen(false); }}
              className={`w-full text-left px-3 py-2 text-xs transition-colors ${
                subAccountId === sa.id
                  ? 'bg-blue-900/30 text-white'
                  : 'text-[#e6edf3] hover:bg-[#21262d]'
              }`}
            >
              {sa.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Sync button ─────────────────────────────────────────────────────────────

function SyncButton() {
  const { syncLoading, syncCooldown, handleManualSync } = useSync();
  return (
    <button
      onClick={handleManualSync}
      disabled={syncLoading || syncCooldown}
      title={syncCooldown ? 'Up to date' : 'Sync new trades from Pacifica'}
      className={`flex items-center justify-center w-7 h-7 rounded transition-colors ${
        syncCooldown
          ? 'text-emerald-400 cursor-default'
          : syncLoading
          ? 'text-[#6e7681] cursor-wait'
          : 'text-[#6e7681] hover:text-white hover:bg-[#21262d]'
      }`}
    >
      <span
        className={`text-sm leading-none ${syncLoading ? 'animate-spin' : ''}`}
        style={syncLoading ? { display: 'inline-block' } : undefined}
      >
        {syncCooldown ? '✓' : '↻'}
      </span>
    </button>
  );
}

// ── Live indicator ──────────────────────────────────────────────────────────

/**
 * Green pulsing dot + "LIVE" label when the server has an active
 * Pacifica websocket for this wallet. Dim grey dot + "OFFLINE" otherwise.
 * Sources its state from LiveContext which is mounted once in AppShell,
 * so navigating between pages doesn't tear down the upstream connection.
 */
function LiveIndicator() {
  const { connected } = useLive();
  return (
    <span
      className={`flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-widest ${
        connected ? 'text-emerald-400' : 'text-[#6e7681]'
      }`}
      title={connected ? 'Connected to Pacifica' : 'Live data unavailable'}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${
          connected ? 'bg-emerald-400 animate-pulse' : 'bg-[#30363d]'
        }`}
      />
      {connected ? 'LIVE' : 'OFFLINE'}
    </span>
  );
}

// ── Wallet badge ────────────────────────────────────────────────────────────

/**
 * Shows the connected wallet (truncated 4+4) and a disconnect button. In
 * dev-bypass mode the disconnect button is hidden — there's no Privy
 * session to log out of, and "logging out" of the dev wallet would just
 * log right back in via AppShell.
 */
function WalletBadge() {
  const { walletAddress } = useJournal();

  if (isDevBypass()) {
    return (
      <span
        className="flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium bg-[#21262d] border border-[#30363d] text-[#e6edf3]"
        title={`Dev wallet: ${walletAddress}`}
      >
        <span className="text-[#6e7681] uppercase tracking-widest text-[9px]">Dev</span>
        <span className="text-white font-mono">{truncate(walletAddress)}</span>
      </span>
    );
  }

  return <PrivyWalletBadge walletAddress={walletAddress} />;
}

function PrivyWalletBadge({ walletAddress }: { walletAddress: string }) {
  const router = useRouter();
  const { ready } = usePrivy();
  const { logout } = useLogout({
    onSuccess: () => router.replace('/connect'),
  });

  return (
    <div className="flex items-center gap-1.5" data-tour="wallet-connect">
      <span
        className="flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium bg-[#21262d] border border-[#30363d] text-[#e6edf3]"
        title={walletAddress}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" aria-hidden />
        <span className="text-white font-mono">{truncate(walletAddress)}</span>
      </span>
      <button
        onClick={logout}
        disabled={!ready}
        className="px-2 py-1.5 rounded text-xs text-[#8b949e] hover:text-white border border-[#30363d] bg-[#21262d] hover:bg-[#30363d] transition-colors disabled:opacity-40"
        title="Disconnect wallet"
      >
        Disconnect
      </button>
    </div>
  );
}
