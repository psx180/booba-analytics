/**
 * GET /api/playbooks/[id]/analytics — aggregate adherence vs outcome for
 * one playbook. Slices the wallet's scored positions into high-adherence
 * (≥80%) and low-adherence (<50%) bands, compares win rates and average
 * P&L, surfaces the most-violated rule.
 *
 * Returns a `notEnoughData` flag instead of empty fields when fewer than
 * 5 positions have been checked — lets the UI render a helpful "need more
 * data" message rather than a zero-filled dashboard that reads as broken.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { prisma } from '@/lib/prisma';
import type { RuleResult } from '@/services/playbooks/types';

const ENOUGH_DATA_THRESHOLD = 5;
const HIGH_ADHERENCE = 80;
const LOW_ADHERENCE = 50;

interface BandStats {
  count: number;
  winRate: number | null; // 0-1
  avgPnl: number | null;
}

function statsFor(positions: { aggregatePnl: number | null }[]): BandStats {
  if (positions.length === 0) return { count: 0, winRate: null, avgPnl: null };
  const pnls = positions.map((p) => p.aggregatePnl ?? 0);
  const wins = pnls.filter((v) => v > 0).length;
  const sum = pnls.reduce((s, v) => s + v, 0);
  return {
    count: positions.length,
    winRate: wins / positions.length,
    avgPnl: sum / positions.length,
  };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (walletAddress) => {
    const { id } = await params;

    const playbook = await prisma.playbook.findUnique({ where: { id } });
    if (!playbook) return NextResponse.json({ error: 'Playbook not found' }, { status: 404 });
    if (playbook.walletAddress !== walletAddress) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Pull only the fields we need — avoids bringing screenshots (base64)
    // and raw-metadata blobs into memory for aggregation.
    const positions = await prisma.position.findMany({
      where: {
        walletAddress,
        playbookId: id,
        adherenceScore: { not: null },
      },
      select: {
        id: true,
        aggregatePnl: true,
        adherenceScore: true,
        adherenceDetail: true,
      },
    });

    if (positions.length < ENOUGH_DATA_THRESHOLD) {
      return NextResponse.json({
        analytics: {
          sampleSize: positions.length,
          highAdherence: null,
          lowAdherence: null,
          mostViolatedRule: null,
          costOfDeviation: null,
          notEnoughData: true,
          enoughDataThreshold: ENOUGH_DATA_THRESHOLD,
        },
      });
    }

    const high = positions.filter((p) => (p.adherenceScore ?? 0) >= HIGH_ADHERENCE);
    const low  = positions.filter((p) => (p.adherenceScore ?? 0) <  LOW_ADHERENCE);

    const highStats = statsFor(high);
    const lowStats  = statsFor(low);

    // Count rule violations across every scored position — the rule that
    // shows up most often in the fail column is the one the trader most
    // consistently ignores. Aggregated by label so rules with the same
    // type but different params (e.g. two EMA rules) are counted separately.
    const violationCounts = new Map<string, number>();
    for (const p of positions) {
      if (!p.adherenceDetail) continue;
      try {
        const results = JSON.parse(p.adherenceDetail) as RuleResult[];
        for (const r of results) {
          if (r.outcome !== 'failed') continue;
          violationCounts.set(r.ruleLabel, (violationCounts.get(r.ruleLabel) ?? 0) + 1);
        }
      } catch {
        // Malformed detail — skip, the rest of the sample is still valid.
      }
    }
    let mostViolatedRule: { label: string; violations: number } | null = null;
    for (const [label, violations] of violationCounts) {
      if (!mostViolatedRule || violations > mostViolatedRule.violations) {
        mostViolatedRule = { label, violations };
      }
    }

    // Cost of deviation: the extra P&L the trader would have earned on the
    // low-adherence trades if those trades had delivered the average P&L
    // of the high-adherence band instead. Only meaningful when both bands
    // have data; null otherwise so the UI can omit the narrative line.
    const costOfDeviation =
      highStats.avgPnl != null && lowStats.avgPnl != null && lowStats.count > 0
        ? (highStats.avgPnl - lowStats.avgPnl) * lowStats.count
        : null;

    return NextResponse.json({
      analytics: {
        sampleSize: positions.length,
        highAdherence: highStats,
        lowAdherence: lowStats,
        mostViolatedRule,
        costOfDeviation,
        notEnoughData: false,
        enoughDataThreshold: ENOUGH_DATA_THRESHOLD,
      },
    });
  });
}
