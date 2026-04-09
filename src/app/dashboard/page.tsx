import DashboardClient from './DashboardClient';

// Hard-coded wallet for now — will come from auth session later.
// Users can override by passing ?wallet= as a query param during dev.
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ wallet?: string }>;
}) {
  const params = await searchParams;
  const walletAddress = params.wallet ?? '32K2iNzqyFTfahrascrWni9tnp7kkmHcUSVkTzKpAGZk';

  return <DashboardClient walletAddress={walletAddress} />;
}
