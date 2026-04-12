import { NextRequest, NextResponse } from 'next/server';
import { createAnalyticsService } from '@/services/analytics';
import { resolveJournalFilterId } from '@/lib/journals';

/**
 * GET  — return stored insights (from booba_observations).
 * POST — re-run all insight detectors, persist, return the fresh results.
 *
 * Both routes accept an optional journalId. When omitted, they fall back to
 * the wallet's default journal — and the persisted observations get tagged
 * with that journal id, so siblings stay isolated.
 */

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const walletAddress = sp.get('walletAddress');
  if (!walletAddress) {
    return NextResponse.json({ error: 'walletAddress required' }, { status: 400 });
  }

  const journalRes = await resolveJournalFilterId(walletAddress, sp.get('journalId'));
  if (!journalRes.valid) {
    return NextResponse.json({ error: 'Journal not found for this wallet' }, { status: 404 });
  }

  const service = createAnalyticsService();
  const insights = await service.getStoredInsights(walletAddress, journalRes.id ?? undefined);
  return NextResponse.json({ insights });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const walletAddress = body.walletAddress;
  if (!walletAddress) {
    return NextResponse.json({ error: 'walletAddress required' }, { status: 400 });
  }

  const journalRes = await resolveJournalFilterId(walletAddress, body.journalId ?? null);
  if (!journalRes.valid) {
    return NextResponse.json({ error: 'Journal not found for this wallet' }, { status: 404 });
  }

  const service = createAnalyticsService();
  const summary = await service.detectInsights(walletAddress, journalRes.id ?? undefined);
  return NextResponse.json(summary);
}