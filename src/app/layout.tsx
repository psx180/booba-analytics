import type { Metadata } from 'next';
import './globals.css';
import AppShell from './AppShell';

export const metadata: Metadata = {
  title: 'Booba — Trade Journal',
  description: 'Pacifica trading journal & analytics',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#0d1117] text-[#e6edf3] font-mono">
        {/* AppShell mounts the JournalProvider so every page can read the
            active journal selection from context, plus renders the nav. */}
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
