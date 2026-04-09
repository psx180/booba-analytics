import { GroupingService } from '../services/grouping';
import { prisma } from '../lib/prisma';

async function main() {
  const wallet = '32K2iNzqyFTfahrascrWni9tnp7kkmHcUSVkTzKpAGZk';
  console.log('Running grouping pipeline...');

  const service = new GroupingService();
  const summary = await service.groupAllFills(wallet);
  console.log('Summary:', JSON.stringify(summary, null, 2));

  const statuses = await prisma.position.groupBy({ by: ['status'], _count: true });
  console.log('\nPosition statuses:', JSON.stringify(statuses));

  // Sample a closed position
  const closed = await prisma.position.findFirst({
    where: { status: 'closed' },
    include: { orderGroups: { include: { _count: { select: { trades: true } } } } },
  });
  if (closed) {
    console.log('\nSample closed position:', closed.asset, 'pnl:', closed.aggregatePnl, 'orders:', closed.orderGroups.length);
  } else {
    console.log('\nNo closed positions found!');
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
