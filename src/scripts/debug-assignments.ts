import { prisma } from '../lib/prisma';

async function main() {
  const unassigned = await prisma.trade.count({ where: { orderGroupId: null } });
  const total = await prisma.trade.count();
  console.log('Fills:', total, 'Unassigned:', unassigned);

  const ogs = await prisma.orderGroup.count();
  const ogsUnassigned = await prisma.orderGroup.count({ where: { positionId: null } });
  console.log('Order groups:', ogs, 'Unassigned to position:', ogsUnassigned);

  const positions = await prisma.position.groupBy({ by: ['status'], _count: true });
  console.log('Position statuses:', JSON.stringify(positions));

  await prisma.$disconnect();
}
main();
