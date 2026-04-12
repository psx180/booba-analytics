import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { Prisma } from '../../../../../generated/prisma/client';
import { withAuth } from '@/lib/api-auth';

/**
 * GET /api/journals/filter-options?walletAddress=X
 *
 * Returns the distinct values that can be used as assign-filter criteria for
 * this wallet. Drives the populated dropdowns in ManageJournalsModal's
 * AssignTradesForm so users don't have to type free-form strings.
 *
 * Uses $queryRaw for reliable DISTINCT behaviour on SQLite.
 */
export async function GET(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {

  const [assetRows, tradeTypeRows, regimeRows, subaccountRows] = await Promise.all([
    prisma.$queryRaw<{ asset: string }[]>(
      Prisma.sql`SELECT DISTINCT asset FROM Position WHERE walletAddress = ${walletAddress} AND asset IS NOT NULL ORDER BY asset ASC`,
    ),
    prisma.$queryRaw<{ tradeType: string }[]>(
      Prisma.sql`SELECT DISTINCT tradeType FROM Position WHERE walletAddress = ${walletAddress} AND tradeType IS NOT NULL ORDER BY tradeType ASC`,
    ),
    prisma.$queryRaw<{ regimeAtEntry: string }[]>(
      Prisma.sql`SELECT DISTINCT regimeAtEntry FROM Position WHERE walletAddress = ${walletAddress} AND regimeAtEntry IS NOT NULL ORDER BY regimeAtEntry ASC`,
    ),
    // Subaccounts live on Trade; walk through OrderGroup to reach the wallet's positions
    prisma.$queryRaw<{ subaccount: string }[]>(
      Prisma.sql`
        SELECT DISTINCT t.subaccount
        FROM Trade t
        INNER JOIN OrderGroup og ON og.id = t.orderGroupId
        INNER JOIN Position p ON p.id = og.positionId
        WHERE p.walletAddress = ${walletAddress}
          AND t.subaccount IS NOT NULL
        ORDER BY t.subaccount ASC
      `,
    ),
  ]);

  return NextResponse.json({
    assets:      assetRows.map((r) => r.asset).filter(Boolean),
    tradeTypes:  tradeTypeRows.map((r) => r.tradeType).filter(Boolean),
    regimes:     regimeRows.map((r) => r.regimeAtEntry).filter(Boolean),
    subaccounts: subaccountRows.map((r) => r.subaccount).filter(Boolean),
  });
  });
}
