import type { Metadata } from 'next';
import './globals.css';
import Providers from './providers';
import AppShell from './AppShell';

export const metadata: Metadata = {
  title: 'Booba — Trade Journal',
  description: 'Pacifica trading journal & analytics',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#0d1117] text-[#e6edf3] font-mono">
        {/* Providers mounts the Privy auth context (or no-ops in dev-bypass
            mode). AppShell consumes that context to gate access to the rest
            of the tree and to feed the connected wallet into JournalProvider. */}
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
