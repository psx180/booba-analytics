/**
 * GET /api/signals/sources — Signal source status and today's signal counts.
 *
 * Returns the five known ingestion source types with:
 *   - configured status (checks env vars server-side)
 *   - experimental badge (Discord/Telegram require manual setup)
 *   - today's signal count from DB
 */

import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { prisma } from '@/lib/prisma';

const KNOWN_SOURCES = ['manual', 'tradingview', 'discord', 'telegram', 'carry_monitor'] as const;
type SourceType = (typeof KNOWN_SOURCES)[number];

interface SourceMeta {
  label: string;
  icon: string;
  experimental: boolean;
  /** Env var to check — if set, source is 'active'; if absent and no signals, 'not_configured' */
  configEnvVar?: string;
  /** Always considered configured regardless of env var */
  alwaysConfigured?: boolean;
}

const SOURCE_META: Record<SourceType, SourceMeta> = {
  manual:        { label: 'Manual Entry',        icon: '📋', experimental: false, alwaysConfigured: true },
  tradingview:   { label: 'TradingView Webhook', icon: '🔗', experimental: false, configEnvVar: 'TRADINGVIEW_WEBHOOK_SECRET' },
  discord:       { label: 'Discord Bot',         icon: '💬', experimental: true },
  telegram:      { label: 'Telegram Bot',        icon: '📱', experimental: true },
  carry_monitor: { label: 'Carry Monitor',       icon: '📊', experimental: false, alwaysConfigured: true },
};

export async function GET(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [todayCounts, allGroups] = await Promise.all([
      prisma.signal.groupBy({
        by: ['source'],
        where: { walletAddress, createdAt: { gte: startOfDay } },
        _count: { id: true },
      }),
      prisma.signal.groupBy({
        by: ['source'],
        where: { walletAddress },
        _count: { id: true },
      }),
    ]);

    const todayMap = new Map(todayCounts.map((r) => [r.source, r._count.id]));
    const seenSources = new Set(allGroups.map((r) => r.source));

    const sources = KNOWN_SOURCES.map((type) => {
      const meta = SOURCE_META[type];
      const todayCount = todayMap.get(type) ?? 0;

      const configured = meta.alwaysConfigured
        ? true
        : meta.configEnvVar
          ? !!process.env[meta.configEnvVar]
          : seenSources.has(type);

      const status: 'active' | 'experimental' | 'not_configured' = meta.experimental
        ? 'experimental'
        : configured
          ? 'active'
          : 'not_configured';

      return {
        type,
        label: meta.label,
        icon: meta.icon,
        status,
        todayCount,
        experimental: meta.experimental,
      };
    });

    return NextResponse.json({ sources });
  });
}
