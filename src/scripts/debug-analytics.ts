import { prisma } from '../lib/prisma';

async function main() {
  const wallet = '32K2iNzqyFTfahrascrWni9tnp7kkmHcUSVkTzKpAGZk';

  const closed = await prisma.position.count({
    where: { walletAddress: wallet, status: 'closed', aggregatePnl: { not: null } },
  });
  console.log('Closed positions with PnL:', closed);

  const sample = await prisma.position.findMany({
    where: { walletAddress: wallet, status: 'closed' },
    select: { aggregatePnl: true, lastExitTime: true },
    take: 5,
  });
  console.log('Sample:', sample.map((p) => ({ pnl: p.aggregatePnl, exit: p.lastExitTime?.toISOString() })));

  await prisma.$disconnect();
}
main();
