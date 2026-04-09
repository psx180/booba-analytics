import TradesClient from './TradesClient';

export default async function TradesPage({
  searchParams,
}: {
  searchParams: Promise<{ wallet?: string }>;
}) {
  const params = await searchParams;
  const walletAddress = params.wallet ?? '32K2iNzqyFTfahrascrWni9tnp7kkmHcUSVkTzKpAGZk';

  return (
    <div>
      <h1 className="text-lg font-semibold text-white mb-4">Trades</h1>
      <TradesClient walletAddress={walletAddress} />
    </div>
  );
}
