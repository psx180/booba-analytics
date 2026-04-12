'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { usePrivy, useLogout } from '@privy-io/react-auth';
import { useJournal } from './JournalContext';
import { useLive } from './LiveContext';
import { isDevBypass } from './privy-env';
import JournalSelector from './JournalSelector';

const tabs = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/trades', label: 'Trades' },
  { href: '/analytics', label: 'Analytics' },
  { href: '#', label: 'Auctions', disabled: true },
  { href: '#', label: 'Settings', disabled: true },
];

function truncate(addr: string): string {
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

export default function NavBar() {
  const pathname = usePathname();

  return (
    <nav className="border-b border-[#21262d] bg-[#161b22]">
      <div className="max-w-[1400px] mx-auto px-4">
        <div className="flex items-center gap-1 h-12">
          <span className="text-sm font-bold text-white mr-4 tracking-wider">BOOBA</span>
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
          {/* Right edge: journal selector + wallet badge. JournalSelector
              stays nearest the tabs; wallet badge is the rightmost element
              so it never moves when the journal name length changes. */}
          <div className="ml-auto flex items-center gap-3">
            <LiveIndicator />
            <JournalSelector />
            <WalletBadge />
          </div>
        </div>
      </div>
    </nav>
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
    <div className="flex items-center gap-1.5">
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
