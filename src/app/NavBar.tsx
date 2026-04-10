'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const tabs = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/trades', label: 'Trades' },
  { href: '/analytics', label: 'Analytics' },
  { href: '#', label: 'Auctions', disabled: true },
  { href: '#', label: 'Settings', disabled: true },
];

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
        </div>
      </div>
    </nav>
  );
}
