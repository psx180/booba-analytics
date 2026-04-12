import { NextRequest, NextResponse } from 'next/server';
import { createAnalyticsService, type Filters } from '@/services/analytics';
import { resolveJournalFilterId } from '@/lib/journals';
import { parseFilters } from '../_filters';
import { withAuth } from '@/lib/api-auth';

/**
 * What-if aggregation.
 *
 * Baseline filters come from the standard filter params (regime, asset, etc).
 * The hypothetical filter comes via `hypotheticalFilter=regime:trending_low_vol`
 * or repeated params like `hypotheticalFilter=regime:trending_low_vol&hypotheticalFilter=asset:BTC-PERP`.
 *
 * Response contains both the unfiltered and filtered performance stats and
 * the delta between them.
 */

export async function GET(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
  const sp = req.nextUrl.searchParams;

  const hypoticalParams = sp.getAll('hypotheticalFilter');
  if (hypoticalParams.length === 0) {
    return NextResponse.json(
      { error: 'hypotheticalFilter required (e.g. regime:trending_low_vol)' },
      { status: 400 },
    );
  }

  const hypotheticalFilter = parseHypothetical(hypoticalParams);

  const journalRes = await resolveJournalFilterId(walletAddress, sp.get('journalId'));
  if (!journalRes.valid) {
    return NextResponse.json({ error: 'Journal not found for this wallet' }, { status: 404 });
  }
  const filters = parseFilters(sp);
  if (journalRes.id) filters.journalId = journalRes.id;

  const service = createAnalyticsService();
  const result = await service.aggregate(
    'what-if',
    walletAddress,
    filters,
    { hypotheticalFilter },
  );
  return NextResponse.json(result);
  });
}

function parseHypothetical(params: string[]): Filters {
  const out: Filters = {};
  for (const p of params) {
    const idx = p.indexOf(':');
    if (idx < 0) continue;
    const key = p.slice(0, idx);
    const value = p.slice(idx + 1);
    if (!value) continue;

    switch (key) {
      case 'regime': out.regime = value; break;
      case 'asset': out.asset = value; break;
      case 'strategy': out.strategy = value; break;
      case 'source': out.source = value; break;
      case 'tradeType': out.tradeType = value; break;
      case 'dateFrom': out.dateFrom = new Date(value); break;
      case 'dateTo': out.dateTo = new Date(value); break;
    }
  }
  return out;
}