import { NextRequest, NextResponse } from 'next/server';
import { createAnalyticsService } from '@/services/analytics';
import { resolveJournalId } from '@/lib/journals';
import { parseFilters } from '../_filters';

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const walletAddress = sp.get('walletAddress');
  if (!walletAddress) {
    return NextResponse.json({ error: 'walletAddress required' }, { status: 400 });
  }

  const service = createAnalyticsService();
  const filters = parseFilters(sp);
  // Resolve journalId once and stamp it onto the filters object so the
  // service's loadFilteredPositions / fillSum query both pick it up.
  // Falls back to the wallet's default journal when omitted.
  const journalId = await resolveJournalId(walletAddress, sp.get('journalId'));
  if (!journalId) {
    return NextResponse.json({ error: 'Journal not found for this wallet' }, { status: 404 });
  }
  filters.journalId = journalId;

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