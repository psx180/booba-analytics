import DashboardClient from './DashboardClient';

// Wallet flows in via JournalContext (which gets it from Privy or the
// dev-bypass fallback in AppShell), not from the URL.
export default function DashboardPage() {
  return <DashboardClient />;
}
