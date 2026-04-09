import { prisma } from '../lib/prisma';

async function main() {
  const statuses = await prisma.position.groupBy({ by: ['status'], _count: true });
  console.log('Position statuses:', JSON.stringify(statuses));

  const total = await prisma.position.count();
  console.log('Total positions:', total);

  // Look at a position with its orders and their fills
  const pos = await prisma.position.findFirst({
    include: {
      orderGroups: {
        include: {
          trades: {
            select: { id: true, direction: true, size: true, exitPrice: true, exitTime: true, entryTime: true, rawData: true },
          },
        },
      },
    },
  });

  if (pos) {
    console.log('\n--- Sample Position ---');
    console.log('Asset:', pos.asset, 'Dir:', pos.direction, 'Status:', pos.status);
    console.log('PnL:', pos.aggregatePnl, 'AvgExit:', pos.averageExitPrice);
    console.log('Orders:', pos.orderGroups.length);

    for (const og of pos.orderGroups) {
      console.log(`\n  Order ${og.id.slice(0,12)}... dir=${og.direction} fills=${og.trades.length}`);
      for (const f of og.trades.slice(0, 3)) {
        const raw = JSON.parse(f.rawData ?? '{}');
        console.log(`    fill: dir=${f.direction} sz=${f.size} exitPx=${f.exitPrice} side=${raw.side} hasEntry=${!!f.entryTime} hasExit=${!!f.exitTime}`);
      }
    }
  }

  // Check side value distribution
  const fills = await prisma.trade.findMany({ take: 20, select: { rawData: true } });
  const sides: Record<string, number> = {};
  for (const f of fills) {
    const raw = JSON.parse(f.rawData ?? '{}');
    const side = raw.side ?? 'unknown';
    sides[side] = (sides[side] ?? 0) + 1;
  }
  console.log('\nSide distribution (first 20):', sides);

  // Count fills by open/close
  const allFills = await prisma.trade.findMany({ select: { rawData: true } });
  let opens = 0, closes = 0, unknown = 0;
  for (const f of allFills) {
    const raw = JSON.parse(f.rawData ?? '{}');
    const side = raw.side ?? '';
    if (side.startsWith('open_')) opens++;
    else if (side.startsWith('close_')) closes++;
    else unknown++;
  }
  console.log(`\nAll fills: opens=${opens} closes=${closes} unknown=${unknown} total=${allFills.length}`);

  await prisma.$disconnect();
}

main();
