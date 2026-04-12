import { NextRequest, NextResponse } from 'next/server';
import { createAnalyticsService } from '@/services/analytics';
import { resolveJournalFilterId } from '@/lib/journals';
import { parseFilters } from '../_filters';

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const walletAddress = sp.get('walletAddress');
  if (!walletAddress) {
    return NextResponse.json({ error: 'walletAddress required' }, { status: 400 });
  }

  const service = createAnalyticsService();
  const filters = parseFilters(sp);
  // Resolve journal scope. Default journal returns id=null → wallet-wide view.
  const journalRes = await resolveJournalFilterId(walletAddress, sp.get('journalId'));
  if (!journalRes.valid) {
    return NextResponse.json({ error: 'Journal not found for this wallet' }, { status: 404 });
  }
  if (journalRes.id) filters.journalId = journalRes.id;

  // Compose the full advanced summary so the dashboard only needs one fetch
  // to populate every stat card. The performance result keeps the legacy
  // top-level shape (`data`, `breakdowns`) the existing client expects;
  // additional results are nested under their own keys.
  const summary = await service.getAdvancedSummary(walletAddress, filters);
  const performance = summary.performance;

  return NextResponse.json({
    ...performance,
    eloResult:              summary.eloResult,
    entropyResult:          summary.entropyResult,
    xpnlLuckScore:          summary.xpnlLuckScore,
    xpnlResult:             summary.xpnl,
    equityCurveConsistency: summary.equityCurveConsistency,
    wartResult:             summary.wartResult,
  });
}