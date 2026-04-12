/**
 * Shared tool functions for Booba chat (Claude tool_use) and MCP servers.
 *
 * Every function takes `walletAddress` as the first parameter so the caller
 * controls authorization. All return plain JSON-serializable objects.
 *
 * Read tools delegate to existing AnalyticsService / Prisma queries.
 * Write tools use a propose/confirm pattern with a 5-minute TTL.
 */

import { prisma } from '@/lib/prisma';
import { createAnalyticsService } from '@/services/analytics';
import { GroupingService } from '@/services/grouping';
import { computeEloResult, type EloResult } from '@/services/analytics/metrics/elo';
import { computeWartResult, type WartResult, type WartDeps } from '@/services/analytics/metrics/wart';
import { computeXpnlResult } from '@/services/analytics/metrics/xpnl';
import { computeEntropyResult } from '@/services/analytics/insights/entropy-insight';
import type { Insight, Filters } from '@/services/analytics/types';
import { resolveJournalFilterId } from '@/lib/journals';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PositionSummary {
  id: string;
  asset: string;
  direction: string;
  status: string;
  pnl: number | null;
  fees: number | null;
  funding: number | null;
  totalSize: number | null;
  averageEntryPrice: number | null;
  averageExitPrice: number | null;
  holdTimeSeconds: number | null;
  firstEntryTime: string | null;
  lastExitTime: string | null;
  regimeAtEntry: string | null;
  tradeType: string | null;
  thesis: string | null;
  emotion: string | null;
  conviction: number | null;
  sourceTag: string | null;
  strategyTag: string | null;
  exitEfficiency: number | null;
  mfePnl: number | null;
  maePnl: number | null;
}

export interface PositionDetail extends PositionSummary {
  orders: {
    id: string;
    totalSize: number | null;
    aggregatePnl: number | null;
    firstEntryTime: string | null;
    lastExitTime: string | null;
    trades: {
      id: string;
      size: number;
      entryPrice: number;
      exitPrice: number | null;
      pnlRealized: number | null;
    }[];
  }[];
  invalidationPrice: number | null;
  targetPrice: string | null;
  mistakes: string | null;
}

export interface PerformanceSummary {
  tradeCount: number;
  winRate: number;
  lossRate: number;
  averageWin: number;
  averageLoss: number;
  expectancy: number;
  profitFactor: number;
  totalPnl: number;
  totalFees: number;
  totalFunding: number;
  avgTiltScore: number;
  tiltEpisodeCount: number;
}

export interface InsightSummary {
  module: string;
  title: string;
  description: string;
  severity: string;
  confidence: number;
  impactScore: number;
  category: string;
  isSignificant: boolean;
  suggestion?: string;
}

export interface RegimeBreakdown {
  groupBy: string;
  groups: Record<string, {
    tradeCount: number;
    winRate: number;
    expectancy: number;
    profitFactor: number;
    totalPnl: number;
  }>;
}

export interface AssetBreakdown {
  groupBy: string;
  groups: Record<string, {
    tradeCount: number;
    winRate: number;
    expectancy: number;
    profitFactor: number;
    totalPnl: number;
  }>;
}

export interface BehavioralSummary {
  avgTiltScore: number;
  tiltEpisodeCount: number;
  dispositionRatio: number | null;
  entropyScore: number;
  entropyTrend: string;
}

export interface ExitAnalysis {
  averageExitEfficiency: number | null;
  moneyLeftOnTable: number;
  mfeSummary: { mean: number; median: number; count: number };
  maeSummary: { mean: number; median: number; count: number };
}

// ─── Proposal store ─────────────────────────────────────────────────────────

interface ProposalData {
  type: 'group' | 'bulk_tag' | 'journal_move' | 'annotation';
  wallet: string;
  payload: any;
  createdAt: number;
}

const proposals = new Map<string, ProposalData>();
const PROPOSAL_TTL = 5 * 60 * 1000; // 5 minutes

function generateProposalId(): string {
  return `prop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function cleanExpired() {
  const now = Date.now();
  for (const [id, data] of proposals) {
    if (now - data.createdAt > PROPOSAL_TTL) proposals.delete(id);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function toPositionSummary(p: any): PositionSummary {
  return {
    id: p.id,
    asset: p.asset,
    direction: p.direction,
    status: p.status,
    pnl: p.aggregatePnl,
    fees: p.aggregateFees,
    funding: p.aggregateFunding,
    totalSize: p.totalSize,
    averageEntryPrice: p.averageEntryPrice,
    averageExitPrice: p.averageExitPrice,
    holdTimeSeconds: p.holdTimeSeconds,
    firstEntryTime: p.firstEntryTime?.toISOString() ?? null,
    lastExitTime: p.lastExitTime?.toISOString() ?? null,
    regimeAtEntry: p.regimeAtEntry,
    tradeType: p.tradeType,
    thesis: p.thesis,
    emotion: p.emotion,
    conviction: p.conviction,
    sourceTag: p.sourceTag,
    strategyTag: p.strategyTag,
    exitEfficiency: p.exitEfficiency,
    mfePnl: p.mfePnl,
    maePnl: p.maePnl,
  };
}

function buildFilters(
  walletAddress: string,
  journalId?: string,
  filters?: {
    asset?: string;
    direction?: string;
    regime?: string;
    tradeType?: string;
    dateFrom?: string;
    dateTo?: string;
  },
): any {
  const where: any = { walletAddress };
  if (journalId) where.journalId = journalId;
  if (filters?.asset) where.asset = filters.asset;
  if (filters?.direction) where.direction = filters.direction;
  if (filters?.regime) where.regimeAtEntry = filters.regime;
  if (filters?.tradeType) where.tradeType = filters.tradeType;
  if (filters?.dateFrom || filters?.dateTo) {
    where.firstEntryTime = {
      ...(filters.dateFrom ? { gte: new Date(filters.dateFrom) } : {}),
      ...(filters.dateTo ? { lte: new Date(filters.dateTo) } : {}),
    };
  }
  return where;
}

function toAnalyticsFilters(journalId?: string, filters?: {
  asset?: string;
  regime?: string;
  tradeType?: string;
  dateFrom?: string;
  dateTo?: string;
}): Filters {
  return {
    journalId: journalId ?? undefined,
    asset: filters?.asset,
    regime: filters?.regime,
    tradeType: filters?.tradeType,
    dateFrom: filters?.dateFrom ? new Date(filters.dateFrom) : undefined,
    dateTo: filters?.dateTo ? new Date(filters.dateTo) : undefined,
  };
}

// ─── Read tools: Trade data ─────────────────────────────────────────────────

export async function getPositions(
  wallet: string,
  journalId?: string,
  filters?: {
    asset?: string;
    direction?: string;
    regime?: string;
    tradeType?: string;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
  },
): Promise<{ positions: PositionSummary[]; total: number }> {
  const where = buildFilters(wallet, journalId, filters);
  const limit = filters?.limit ?? 20;

  const [positions, total] = await Promise.all([
    prisma.position.findMany({
      where,
      orderBy: { firstEntryTime: 'desc' },
      take: limit,
    }),
    prisma.position.count({ where }),
  ]);

  return {
    positions: positions.map(toPositionSummary),
    total,
  };
}

export async function getPositionDetail(
  wallet: string,
  positionId: string,
): Promise<PositionDetail | null> {
  const position = await prisma.position.findUnique({
    where: { id: positionId },
    include: {
      orderGroups: {
        include: {
          trades: {
            select: {
              id: true,
              size: true,
              entryPrice: true,
              exitPrice: true,
              pnlRealized: true,
            },
          },
        },
      },
    },
  });

  if (!position || position.walletAddress !== wallet) return null;

  return {
    ...toPositionSummary(position),
    invalidationPrice: position.invalidationPrice,
    targetPrice: position.targetPrice,
    mistakes: position.mistakes,
    orders: position.orderGroups.map((og) => ({
      id: og.id,
      totalSize: og.totalSize,
      aggregatePnl: og.aggregatePnl,
      firstEntryTime: og.firstEntryTime?.toISOString() ?? null,
      lastExitTime: og.lastExitTime?.toISOString() ?? null,
      trades: og.trades.map((t) => ({
        id: t.id,
        size: t.size,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        pnlRealized: t.pnlRealized,
      })),
    })),
  };
}

export async function getRecentTrades(
  wallet: string,
  n: number = 10,
): Promise<PositionSummary[]> {
  const positions = await prisma.position.findMany({
    where: { walletAddress: wallet },
    orderBy: { firstEntryTime: 'desc' },
    take: n,
  });
  return positions.map(toPositionSummary);
}

export async function getOpenPositions(
  wallet: string,
): Promise<PositionSummary[]> {
  const positions = await prisma.position.findMany({
    where: { walletAddress: wallet, status: 'open' },
    orderBy: { firstEntryTime: 'desc' },
  });
  return positions.map(toPositionSummary);
}

export async function searchTrades(
  wallet: string,
  query: string,
): Promise<PositionSummary[]> {
  // SQLite text search across thesis, notes, strategy names, asset names
  const q = `%${query}%`;
  const positions = await prisma.position.findMany({
    where: {
      walletAddress: wallet,
      OR: [
        { thesis: { contains: query } },
        { asset: { contains: query } },
        { strategyTag: { contains: query } },
        { sourceTag: { contains: query } },
        { emotion: { contains: query } },
        { mistakes: { contains: query } },
      ],
    },
    orderBy: { firstEntryTime: 'desc' },
    take: 20,
  });
  return positions.map(toPositionSummary);
}

// ─── Read tools: Analytics ──────────────────────────────────────────────────

export async function getPerformanceSummary(
  wallet: string,
  journalId?: string,
): Promise<PerformanceSummary> {
  const analytics = createAnalyticsService();
  const filters = toAnalyticsFilters(journalId);
  const result = await analytics.aggregate('performance', wallet, filters);
  const d = result.data;
  return {
    tradeCount: d.tradeCount ?? 0,
    winRate: d.winRate ?? 0,
    lossRate: d.lossRate ?? 0,
    averageWin: d.averageWin ?? 0,
    averageLoss: d.averageLoss ?? 0,
    expectancy: d.expectancy ?? 0,
    profitFactor: d.profitFactor ?? 0,
    totalPnl: d.totalPnl ?? 0,
    totalFees: d.totalFees ?? 0,
    totalFunding: d.totalFunding ?? 0,
    avgTiltScore: d.avgTiltScore ?? 0,
    tiltEpisodeCount: d.tiltEpisodeCount ?? 0,
  };
}

export async function getWartScore(
  wallet: string,
  journalId?: string,
): Promise<WartResult> {
  const analytics = createAnalyticsService();
  const summary = await analytics.getAdvancedSummary(wallet, toAnalyticsFilters(journalId));
  return summary.wartResult;
}

export async function getEloRating(
  wallet: string,
  journalId?: string,
): Promise<EloResult> {
  const analytics = createAnalyticsService();
  const summary = await analytics.getAdvancedSummary(wallet, toAnalyticsFilters(journalId));
  return summary.eloResult;
}

export async function getInsights(
  wallet: string,
  journalId?: string,
): Promise<InsightSummary[]> {
  const analytics = createAnalyticsService();
  const { insights } = await analytics.getStoredInsights(wallet, journalId);
  return insights.map((i) => ({
    module: i.module,
    title: i.title,
    description: i.description,
    severity: i.severity,
    confidence: i.confidence,
    impactScore: i.impactScore,
    category: i.category,
    isSignificant: i.isSignificant,
    suggestion: i.suggestion,
  }));
}

export async function getRegimeBreakdown(
  wallet: string,
  journalId?: string,
): Promise<RegimeBreakdown> {
  const analytics = createAnalyticsService();
  const result = await analytics.aggregate('breakdown', wallet, toAnalyticsFilters(journalId), { groupBy: 'regime' });
  const groups: RegimeBreakdown['groups'] = {};
  if (result.breakdowns?.regime) {
    for (const [regime, stats] of Object.entries(result.breakdowns.regime)) {
      const s = stats as any;
      groups[regime] = {
        tradeCount: s.tradeCount ?? 0,
        winRate: s.winRate ?? 0,
        expectancy: s.expectancy ?? 0,
        profitFactor: s.profitFactor ?? 0,
        totalPnl: s.totalPnl ?? 0,
      };
    }
  }
  return { groupBy: 'regime', groups };
}

export async function getAssetBreakdown(
  wallet: string,
  journalId?: string,
): Promise<AssetBreakdown> {
  const analytics = createAnalyticsService();
  const result = await analytics.aggregate('breakdown', wallet, toAnalyticsFilters(journalId), { groupBy: 'asset' });
  const groups: AssetBreakdown['groups'] = {};
  if (result.breakdowns?.asset) {
    for (const [asset, stats] of Object.entries(result.breakdowns.asset)) {
      const s = stats as any;
      groups[asset] = {
        tradeCount: s.tradeCount ?? 0,
        winRate: s.winRate ?? 0,
        expectancy: s.expectancy ?? 0,
        profitFactor: s.profitFactor ?? 0,
        totalPnl: s.totalPnl ?? 0,
      };
    }
  }
  return { groupBy: 'asset', groups };
}

export async function getBehavioralPatterns(
  wallet: string,
  journalId?: string,
): Promise<BehavioralSummary> {
  const analytics = createAnalyticsService();
  const summary = await analytics.getAdvancedSummary(wallet, toAnalyticsFilters(journalId));
  const perf = summary.performance.data;
  return {
    avgTiltScore: perf.avgTiltScore ?? 0,
    tiltEpisodeCount: perf.tiltEpisodeCount ?? 0,
    dispositionRatio: null, // computed from insights if available
    entropyScore: summary.entropyResult.compositeScore,
    entropyTrend: summary.entropyResult.trend,
  };
}

export async function getExitAnalysis(
  wallet: string,
  journalId?: string,
): Promise<ExitAnalysis> {
  const where: any = { walletAddress: wallet, status: 'closed' };
  if (journalId) where.journalId = journalId;

  const positions = await prisma.position.findMany({ where });

  const withMfe = positions.filter((p) => p.mfePnl != null && p.mfePnl > 0 && (p.aggregatePnl ?? 0) > 0);
  let avgEfficiency: number | null = null;
  if (withMfe.length > 0) {
    const sum = withMfe.reduce((s, p) => s + Math.min(1, (p.aggregatePnl ?? 0) / (p.mfePnl ?? 1)), 0);
    avgEfficiency = Math.round((sum / withMfe.length) * 1000) / 1000;
  }

  const moneyLeft = positions.reduce((s, p) => {
    if (p.mfePnl != null && (p.aggregatePnl ?? 0) > 0) {
      return s + (p.mfePnl - (p.aggregatePnl ?? 0));
    }
    return s;
  }, 0);

  const mfeValues = positions.filter((p) => p.mfePnl != null).map((p) => p.mfePnl!);
  const maeValues = positions.filter((p) => p.maePnl != null).map((p) => p.maePnl!);

  function stats(arr: number[]) {
    if (arr.length === 0) return { mean: 0, median: 0, count: 0 };
    const sorted = [...arr].sort((a, b) => a - b);
    const mean = Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 100) / 100;
    const median = sorted[Math.floor(sorted.length / 2)];
    return { mean, median: Math.round(median * 100) / 100, count: arr.length };
  }

  return {
    averageExitEfficiency: avgEfficiency,
    moneyLeftOnTable: Math.round(moneyLeft * 100) / 100,
    mfeSummary: stats(mfeValues),
    maeSummary: stats(maeValues),
  };
}

// ─── Write tools: Propose/Confirm ───────────────────────────────────────────

export async function proposeGroupAction(
  wallet: string,
  description: string,
): Promise<{
  proposalId: string;
  action: 'merge' | 'link' | 'split';
  affectedPositions: { id: string; asset: string; direction: string; pnl: number }[];
  summary: string;
}> {
  cleanExpired();

  // Parse natural language description to find matching positions
  const descLower = description.toLowerCase();

  // Detect action type
  let action: 'merge' | 'link' | 'split' = 'merge';
  if (descLower.includes('link') || descLower.includes('pair') || descLower.includes('delta neutral') || descLower.includes('hedge')) {
    action = 'link';
  } else if (descLower.includes('split')) {
    action = 'split';
  }

  // Extract asset names
  const allPositions = await prisma.position.findMany({
    where: { walletAddress: wallet },
    orderBy: { firstEntryTime: 'desc' },
  });

  const assets = [...new Set(allPositions.map((p) => p.asset))];
  const mentionedAssets = assets.filter((a) => descLower.includes(a.toLowerCase()));

  // Extract direction
  let direction: string | undefined;
  if (descLower.includes('long')) direction = 'long';
  if (descLower.includes('short')) direction = 'short';

  // Filter candidates
  let candidates = allPositions;
  if (mentionedAssets.length > 0) {
    candidates = candidates.filter((p) => mentionedAssets.includes(p.asset));
  }
  if (direction && action !== 'link') {
    candidates = candidates.filter((p) => p.direction === direction);
  }

  // For counter-trades / hedges, find opposing positions in the same asset
  if (descLower.includes('counter') || descLower.includes('hedge') || descLower.includes('opposite')) {
    const grouped = new Map<string, any[]>();
    for (const p of candidates) {
      const key = p.asset;
      (grouped.get(key) || (grouped.set(key, []), grouped.get(key)!)).push(p);
    }
    const pairs: any[] = [];
    for (const [, group] of grouped) {
      const longs = group.filter((p: any) => p.direction === 'long');
      const shorts = group.filter((p: any) => p.direction === 'short');
      if (longs.length > 0 && shorts.length > 0) {
        pairs.push(...longs.slice(0, 3), ...shorts.slice(0, 3));
      }
    }
    if (pairs.length > 0) candidates = pairs;
  }

  // Time proximity — look for "within X minutes" patterns
  const timeMatch = description.match(/within\s+(\d+)\s*(minutes?|mins?|hours?|hrs?)/i);
  if (timeMatch && candidates.length > 1) {
    const minutes = timeMatch[2]?.startsWith('h') ? parseInt(timeMatch[1]) * 60 : parseInt(timeMatch[1]);
    const windowMs = minutes * 60 * 1000;
    // Find clusters
    const sorted = [...candidates].sort((a, b) =>
      (a.firstEntryTime?.getTime() ?? 0) - (b.firstEntryTime?.getTime() ?? 0),
    );
    const clustered: any[] = [];
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const dt = Math.abs(
          (sorted[j].firstEntryTime?.getTime() ?? 0) - (sorted[i].firstEntryTime?.getTime() ?? 0),
        );
        if (dt <= windowMs) {
          if (!clustered.includes(sorted[i])) clustered.push(sorted[i]);
          if (!clustered.includes(sorted[j])) clustered.push(sorted[j]);
        }
      }
    }
    if (clustered.length >= 2) candidates = clustered;
  }

  // Limit to reasonable number
  candidates = candidates.slice(0, 10);

  if (candidates.length < 2) {
    return {
      proposalId: '',
      action,
      affectedPositions: [],
      summary: `Could not find enough matching positions for "${description}". Try being more specific about the asset, direction, or time range.`,
    };
  }

  const affected = candidates.map((p) => ({
    id: p.id,
    asset: p.asset,
    direction: p.direction,
    pnl: p.aggregatePnl ?? 0,
  }));

  const proposalId = generateProposalId();
  proposals.set(proposalId, {
    type: 'group',
    wallet,
    payload: { action, positionIds: candidates.map((p) => p.id) },
    createdAt: Date.now(),
  });

  const assetList = [...new Set(affected.map((p) => p.asset))].join(', ');
  const summary = `Found ${affected.length} ${assetList} positions to ${action}. Total P&L: $${affected.reduce((s, p) => s + p.pnl, 0).toFixed(2)}.`;

  return { proposalId, action, affectedPositions: affected, summary };
}

export async function proposeBulkTag(
  wallet: string,
  field: string,
  value: string,
  filter: {
    asset?: string;
    direction?: string;
    regime?: string;
    dateFrom?: string;
    dateTo?: string;
  },
): Promise<{
  proposalId: string;
  affectedCount: number;
  preview: { id: string; asset: string; currentValue: string | null }[];
  summary: string;
}> {
  cleanExpired();

  const validFields = ['strategy', 'thesis', 'emotion', 'sourceTag'];
  if (!validFields.includes(field)) {
    return {
      proposalId: '',
      affectedCount: 0,
      preview: [],
      summary: `Invalid field "${field}". Valid fields: ${validFields.join(', ')}`,
    };
  }

  const dbField = field === 'strategy' ? 'strategyTag' : field;
  const where = buildFilters(wallet, undefined, filter);
  const positions = await prisma.position.findMany({ where, take: 100 });

  if (positions.length === 0) {
    return {
      proposalId: '',
      affectedCount: 0,
      preview: [],
      summary: 'No positions match the given filter.',
    };
  }

  const preview = positions.slice(0, 5).map((p: any) => ({
    id: p.id,
    asset: p.asset,
    currentValue: p[dbField] ?? null,
  }));

  const proposalId = generateProposalId();
  proposals.set(proposalId, {
    type: 'bulk_tag',
    wallet,
    payload: {
      field: dbField,
      value,
      positionIds: positions.map((p) => p.id),
    },
    createdAt: Date.now(),
  });

  const summary = `Will set "${field}" to "${value}" on ${positions.length} positions.`;
  return { proposalId, affectedCount: positions.length, preview, summary };
}

export async function proposeJournalMove(
  wallet: string,
  filter: {
    asset?: string;
    direction?: string;
    regime?: string;
    dateFrom?: string;
    dateTo?: string;
  },
  targetJournalName: string,
): Promise<{
  proposalId: string;
  affectedCount: number;
  targetJournal: string;
  summary: string;
}> {
  cleanExpired();

  // Find or identify target journal
  const journal = await prisma.journal.findFirst({
    where: {
      walletAddress: wallet,
      name: { contains: targetJournalName },
    },
  });

  if (!journal) {
    return {
      proposalId: '',
      affectedCount: 0,
      targetJournal: targetJournalName,
      summary: `Journal "${targetJournalName}" not found. Available journals can be viewed in the journal selector.`,
    };
  }

  const where = buildFilters(wallet, undefined, filter);
  const positions = await prisma.position.findMany({ where, take: 200 });

  if (positions.length === 0) {
    return {
      proposalId: '',
      affectedCount: 0,
      targetJournal: journal.name,
      summary: 'No positions match the given filter.',
    };
  }

  const proposalId = generateProposalId();
  proposals.set(proposalId, {
    type: 'journal_move',
    wallet,
    payload: {
      positionIds: positions.map((p) => p.id),
      targetJournalId: journal.id,
    },
    createdAt: Date.now(),
  });

  const summary = `Will move ${positions.length} positions to journal "${journal.name}".`;
  return { proposalId, affectedCount: positions.length, targetJournal: journal.name, summary };
}

export async function proposeAnnotation(
  wallet: string,
  positionIds: string[],
  annotations: {
    strategy?: string;
    thesis?: string;
    emotion?: string;
    conviction?: number;
  },
): Promise<{
  proposalId: string;
  affectedCount: number;
  summary: string;
}> {
  cleanExpired();

  // Verify all positions belong to this wallet
  const positions = await prisma.position.findMany({
    where: { id: { in: positionIds }, walletAddress: wallet },
  });

  if (positions.length === 0) {
    return {
      proposalId: '',
      affectedCount: 0,
      summary: 'No matching positions found for this wallet.',
    };
  }

  const proposalId = generateProposalId();
  proposals.set(proposalId, {
    type: 'annotation',
    wallet,
    payload: {
      positionIds: positions.map((p) => p.id),
      annotations,
    },
    createdAt: Date.now(),
  });

  const fields = Object.keys(annotations).filter((k) => (annotations as any)[k] != null);
  const summary = `Will annotate ${positions.length} positions with: ${fields.join(', ')}.`;
  return { proposalId, affectedCount: positions.length, summary };
}

export async function executeProposal(
  wallet: string,
  proposalId: string,
): Promise<{
  success: boolean;
  message: string;
  affectedCount: number;
}> {
  cleanExpired();

  const proposal = proposals.get(proposalId);
  if (!proposal) {
    return { success: false, message: 'Proposal not found or expired.', affectedCount: 0 };
  }
  if (proposal.wallet !== wallet) {
    return { success: false, message: 'Unauthorized.', affectedCount: 0 };
  }

  proposals.delete(proposalId);

  try {
    switch (proposal.type) {
      case 'group': {
        const { action, positionIds } = proposal.payload;
        const service = new GroupingService();
        if (action === 'merge') {
          await service.mergePositions(positionIds);
          return { success: true, message: `Merged ${positionIds.length} positions.`, affectedCount: positionIds.length };
        } else if (action === 'link') {
          await service.linkPositions(positionIds, 'delta_neutral');
          return { success: true, message: `Linked ${positionIds.length} positions.`, affectedCount: positionIds.length };
        }
        return { success: false, message: `Split not supported via proposal.`, affectedCount: 0 };
      }

      case 'bulk_tag': {
        const { field, value, positionIds } = proposal.payload;
        await prisma.position.updateMany({
          where: { id: { in: positionIds }, walletAddress: wallet },
          data: { [field]: value },
        });
        return { success: true, message: `Tagged ${positionIds.length} positions.`, affectedCount: positionIds.length };
      }

      case 'journal_move': {
        const { positionIds, targetJournalId } = proposal.payload;
        await prisma.position.updateMany({
          where: { id: { in: positionIds }, walletAddress: wallet },
          data: { journalId: targetJournalId },
        });
        return { success: true, message: `Moved ${positionIds.length} positions.`, affectedCount: positionIds.length };
      }

      case 'annotation': {
        const { positionIds, annotations } = proposal.payload;
        const data: any = {};
        if (annotations.strategy) data.strategyTag = annotations.strategy;
        if (annotations.thesis) data.thesis = annotations.thesis;
        if (annotations.emotion) data.emotion = annotations.emotion;
        if (annotations.conviction != null) data.conviction = annotations.conviction;
        await prisma.position.updateMany({
          where: { id: { in: positionIds }, walletAddress: wallet },
          data,
        });
        return { success: true, message: `Annotated ${positionIds.length} positions.`, affectedCount: positionIds.length };
      }

      default:
        return { success: false, message: 'Unknown proposal type.', affectedCount: 0 };
    }
  } catch (err: any) {
    return { success: false, message: err.message ?? 'Execution failed.', affectedCount: 0 };
  }
}
