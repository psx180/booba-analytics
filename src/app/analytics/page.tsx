import AnalyticsClient from './AnalyticsClient';

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ wallet?: string }>;
}) {
  const params = await searchParams;
  const walletAddress = params.wallet ?? '32K2iNzqyFTfahrascrWni9tnp7kkmHcUSVkTzKpAGZk';

  return <AnalyticsClient walletAddress={walletAddress} />;
}
