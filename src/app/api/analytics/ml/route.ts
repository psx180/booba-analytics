/**
 * GET /api/analytics/ml
 *
 * Returns the cached ML pattern-discovery results — clustering, anomaly
 * detection, and Markov serial-dependence — for a wallet.
 *
 * The results are populated by the `ml-patterns` insight detector, which
 * runs as part of the standard `detectInsights()` pipeline kicked off by
 * "Compute Analytics" (POST /api/analytics/metrics/compute). We don't run
 * the ML analyses on every GET because they're more expensive than the
 * statistical-test detectors.
 *
 * The shape of each cached blob is whatever the detector emitted into the
 * Insight `data` field — see insights/ml-patterns.ts for definitions.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { resolveJournalFilterId } from '@/lib/journals';
import { withAuth } from '@/lib/api-auth';
import type { ClusteringResult } from '@/services/analytics/ml/clustering';
import type { AnomalyResult } from '@/services/analytics/ml/anomaly';
import type { MarkovResult } from '@/services/analytics/ml/markov';

interface MlAnalyticsResponse {
  clustering: ClusteringResult | null;
  anomalies: AnomalyResult | null;
  markov: MarkovResult | null;
  /** ISO timestamp of the most recent observation we found, if any. */
  computedAt: string | null;
}

const ML_MODULES = [
  'ml-patterns-clustering',
  'ml-patterns-anomaly',
  'ml-patterns-markov',
] as const;

export async function GET(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
  const sp = req.nextUrl.searchParams;

  // ML results are cached per journal — observations were generated against
  // a specific journal's positions, so reading them with a different journal
  // scope would surface stale or irrelevant patterns.
  const journalRes = await resolveJournalFilterId(walletAddress, sp.get('journalId'));
  if (!journalRes.valid) {
    return NextResponse.json({ error: 'Journal not found for this wallet' }, { status: 404 });
  }

  const obsWhere: any = {
    walletAddress,
    isActive: true,
    sourceModule: { in: ML_MODULES as unknown as string[] },
  };
  // Default journal (id=null) → wallet-wide: no journalId filter on observations.
  if (journalRes.id) obsWhere.journalId = journalRes.id;

  const rows = await prisma.boobaObservation.findMany({
    where: obsWhere,
    orderBy: { createdAt: 'desc' },
  });

  const result: MlAnalyticsResponse = {
    clustering: null,
    anomalies: null,
    markov: null,
    computedAt: null,
  };

  // Walk newest-first; first hit per module wins
  for (const row of rows) {
    if (!row.sourceModule) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(row.observationText);
    } catch {
      continue;
    }
    const data = parsed?.data ?? {};

    if (row.sourceModule === 'ml-patterns-clustering' && !result.clustering) {
      result.clustering = data.clustering ?? null;
    } else if (row.sourceModule === 'ml-patterns-anomaly' && !result.anomalies) {
      result.anomalies = data.anomalies ?? null;
    } else if (row.sourceModule === 'ml-patterns-markov' && !result.markov) {
      result.markov = data.markov ?? null;
    }

    if (!result.computedAt) {
      result.computedAt = row.createdAt.toISOString();
    }
  }

  return NextResponse.json(result);
  });
}
