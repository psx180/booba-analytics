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
import { computeCallerAnalytics } from '@/services/signals/caller-analytics';
import { getCarryOpportunities as fetchCarryOpportunities } from '@/services/pacifica/carry-service';
import { runMonteCarloSimulation } from '@/services/analytics/monte-carlo';
import { computeWalkForward } from '@/services/analytics/walk-forward';
import { computeWhatIfCurves } from '@/services/analytics/what-if-curves';

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

// ─── New read tools: Signals & Callers ─────────────────────────────────────

export async function getSignals(
  wallet: string,
  filters?: { status?: string; caller?: string; limit?: number },
): Promise<{ signals: any[]; total: number }> {
  const limit = Math.min(filters?.limit ?? 20, 100);
  const where: any = { walletAddress: wallet };
  if (filters?.status) where.status = filters.status;
  if (filters?.caller) where.callerName = filters.caller;

  const [signals, total] = await Promise.all([
    prisma.signal.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit }),
    prisma.signal.count({ where }),
  ]);

  return { signals, total };
}

export async function getCallerLeaderboard(wallet: string): Promise<{ callers: any[] }> {
  const signals = await prisma.signal.findMany({
    where: { walletAddress: wallet },
    select: {
      callerName: true,
      asset: true,
      direction: true,
      status: true,
      outcomePnlPct: true,
      outcomeRMultiple: true,
      targetPricesHit: true,
    },
  });

  const byCallerMap = new Map<string, typeof signals>();
  for (const s of signals) {
    const arr = byCallerMap.get(s.callerName) ?? [];
    arr.push(s);
    byCallerMap.set(s.callerName, arr);
  }

  const callers: any[] = [];
  for (const [callerName, callerSignals] of byCallerMap) {
    const hitTargets    = callerSignals.filter((s) => s.status === 'hit_target').length;
    const hitStops      = callerSignals.filter((s) => s.status === 'hit_stop').length;
    const partialTargets = callerSignals.filter((s) => s.status === 'partial_target').length;
    const expired       = callerSignals.filter((s) => s.status === 'expired').length;
    const open          = callerSignals.filter((s) => s.status === 'open').length;
    const resolved      = hitTargets + hitStops + partialTargets + expired;

    let hitPoints = hitTargets;
    for (const s of callerSignals) {
      if (s.status === 'partial_target' && s.targetPricesHit) {
        try {
          const flags = JSON.parse(s.targetPricesHit) as boolean[];
          const hitCount = flags.filter(Boolean).length;
          hitPoints += flags.length > 0 ? hitCount / flags.length : 0;
        } catch { /* ignore malformed JSON */ }
      }
    }
    const hitRate = resolved > 0 ? hitPoints / resolved : 0;

    const resolvedWithPnl = callerSignals.filter((s) => s.status !== 'open' && s.outcomePnlPct != null);
    const avgPnlPct = resolvedWithPnl.length > 0
      ? resolvedWithPnl.reduce((sum, s) => sum + s.outcomePnlPct!, 0) / resolvedWithPnl.length
      : null;

    const resolvedWithR = callerSignals.filter((s) => s.status !== 'open' && s.outcomeRMultiple != null);
    const avgRMultiple = resolvedWithR.length > 0
      ? resolvedWithR.reduce((sum, s) => sum + s.outcomeRMultiple!, 0) / resolvedWithR.length
      : null;

    callers.push({
      callerName,
      totalSignals: callerSignals.length,
      hitTargets,
      hitStops,
      partialTargets,
      expired,
      open,
      hitRate: Math.round(hitRate * 10000) / 10000,
      avgPnlPct: avgPnlPct != null ? Math.round(avgPnlPct * 100) / 100 : null,
      avgRMultiple: avgRMultiple != null ? Math.round(avgRMultiple * 100) / 100 : null,
    });
  }

  callers.sort((a, b) => {
    if (a.avgPnlPct == null && b.avgPnlPct == null) return 0;
    if (a.avgPnlPct == null) return 1;
    if (b.avgPnlPct == null) return -1;
    return b.avgPnlPct - a.avgPnlPct;
  });

  return { callers };
}

export async function getCallerAnalytics(wallet: string, callerName: string): Promise<any> {
  const result = await computeCallerAnalytics(wallet, callerName);
  if (!result) {
    return { error: `Not enough data for ${callerName}. Need at least 5 resolved signals.` };
  }
  return result;
}

// ─── New read tools: Carry & Funding ───────────────────────────────────────

export async function getCarryOpportunities(wallet: string): Promise<{ opportunities: any[] }> {
  const opportunities = await fetchCarryOpportunities(wallet);
  return { opportunities };
}

export async function getFundingStatus(wallet: string): Promise<{
  positions: { asset: string; direction: string; fundingRate: number; hourlyPayment: number; annualizedCost: number }[];
}> {
  const openPositions = await prisma.position.findMany({
    where: { walletAddress: wallet, status: 'open' },
    select: { asset: true, direction: true, totalSize: true, averageEntryPrice: true },
  });

  if (openPositions.length === 0) return { positions: [] };

  const base = process.env.PACIFICA_CARRY_API_URL
    ?? process.env.NEXT_PUBLIC_PACIFICA_API_URL
    ?? 'https://api.pacifica.fi';

  const priceMap = new Map<string, number>();
  try {
    const res = await fetch(`${base}/api/v1/info/prices`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) {
      const json: any = await res.json();
      const prices: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
      for (const p of prices) {
        if (p.symbol && p.funding != null) {
          priceMap.set(String(p.symbol).toUpperCase(), parseFloat(String(p.funding)));
        }
      }
    }
  } catch { /* degrade gracefully — return 0 funding rates */ }

  const result = openPositions.map((p) => {
    const assetKey = `${p.asset}-PERP`;
    const fundingRate = priceMap.get(assetKey) ?? priceMap.get(p.asset.toUpperCase()) ?? 0;
    const notional = (p.totalSize ?? 0) * (p.averageEntryPrice ?? 0);
    // Longs pay when funding > 0, shorts receive
    const isLong = p.direction?.toLowerCase() === 'long';
    const hourlyPayment = isLong ? fundingRate * notional : -fundingRate * notional;
    const annualizedCost = fundingRate * 24 * 365 * 100 * (isLong ? 1 : -1);

    return {
      asset: p.asset,
      direction: p.direction ?? 'unknown',
      fundingRate,
      hourlyPayment: Math.round(hourlyPayment * 100) / 100,
      annualizedCost: Math.round(annualizedCost * 100) / 100,
    };
  });

  return { positions: result };
}

// ─── New read tools: Advanced Analytics ────────────────────────────────────

export async function getWhatIfAnalysis(wallet: string, journalId?: string): Promise<any> {
  return computeWhatIfCurves(prisma as any, wallet, journalId);
}

export async function getMonteCarloSimulation(wallet: string, journalId?: string): Promise<any> {
  const where: any = { walletAddress: wallet, status: 'closed' };
  if (journalId) where.journalId = journalId;

  const positions = await prisma.position.findMany({
    where,
    select: { aggregatePnl: true, totalSize: true, averageEntryPrice: true },
  });

  if (positions.length < 10) {
    return { error: 'Not enough data for simulation', tradeCount: positions.length, required: 10 };
  }

  const pnlValues = positions.map((p) => p.aggregatePnl ?? 0);
  const winners = pnlValues.filter((v) => v > 0);
  const winRate = winners.length / pnlValues.length;

  // Compute percentage returns using notional value (size * entry price)
  const withNotional = positions.filter(
    (p) => p.totalSize != null && p.averageEntryPrice != null && p.totalSize > 0 && p.averageEntryPrice > 0,
  );

  let winReturnPcts: number[] | undefined;
  let lossReturnPcts: number[] | undefined;
  let avgWinPct = 3;
  let avgLossPct = -2;

  if (withNotional.length >= 10) {
    const pctReturns = withNotional.map((p) => {
      const notional = (p.totalSize ?? 1) * (p.averageEntryPrice ?? 1);
      return ((p.aggregatePnl ?? 0) / notional) * 100;
    });
    const winPcts = pctReturns.filter((v) => v > 0);
    const lossPcts = pctReturns.filter((v) => v < 0);
    if (winPcts.length > 0) {
      avgWinPct = winPcts.reduce((s, v) => s + v, 0) / winPcts.length;
      winReturnPcts = winPcts;
    }
    if (lossPcts.length > 0) {
      avgLossPct = lossPcts.reduce((s, v) => s + v, 0) / lossPcts.length;
      lossReturnPcts = lossPcts;
    }
  }

  const result = runMonteCarloSimulation({
    winRate,
    avgWinPct,
    avgLossPct,
    tradeCount: 100,
    simulations: 5_000,
    initialBalance: 10_000,
    winReturnPcts: winReturnPcts && winReturnPcts.length >= 10 ? winReturnPcts : undefined,
    lossReturnPcts: lossReturnPcts && lossReturnPcts.length >= 10 ? lossReturnPcts : undefined,
  });

  // Strip equityCurves — too large for Claude's context window
  const { equityCurves, ...summary } = result;
  return { ...summary, tradeCount: pnlValues.length, winRate };
}

export async function getWalkForwardValidation(wallet: string, journalId?: string): Promise<any> {
  const result = await computeWalkForward(prisma as any, wallet, journalId);
  if (!result) {
    return { error: 'Not enough data for walk-forward analysis. Need at least 30 closed trades.' };
  }
  return result;
}

// ─── New read tools: Market Context ────────────────────────────────────────

export async function getCurrentRegime(_wallet: string): Promise<{ regime: string; confidence: string }> {
  const snapshot = await prisma.regimeSnapshot.findFirst({
    where: { asset: 'BTC' },
    orderBy: { timestamp: 'desc' },
  });

  if (!snapshot) {
    return { regime: 'unknown', confidence: 'No regime data available yet' };
  }

  const conf = snapshot.confidence as number | null;
  const confidence = conf == null ? 'unknown' : conf > 0.7 ? 'high' : conf > 0.4 ? 'medium' : 'low';

  return {
    regime: snapshot.regimeClassification ?? 'unknown',
    confidence,
  };
}

// ─── New read tools: Playbooks ──────────────────────────────────────────────

export async function getPlaybooks(wallet: string): Promise<{ playbooks: any[] }> {
  const playbooks = await prisma.playbook.findMany({
    where: { walletAddress: wallet },
    orderBy: { createdAt: 'desc' },
  });
  return { playbooks };
}

export async function getPlaybookAdherence(wallet: string, playbookId: string): Promise<any> {
  const playbook = await prisma.playbook.findUnique({ where: { id: playbookId } });
  if (!playbook || playbook.walletAddress !== wallet) {
    return { error: 'Playbook not found' };
  }

  const positions = await prisma.position.findMany({
    where: { walletAddress: wallet, playbookId, adherenceScore: { not: null } },
    select: { id: true, aggregatePnl: true, adherenceScore: true, adherenceDetail: true },
  });

  if (positions.length < 5) {
    return {
      playbookName: playbook.name,
      sampleSize: positions.length,
      notEnoughData: true,
      message: 'Need at least 5 scored positions for adherence analysis.',
    };
  }

  const scores = positions.map((p) => p.adherenceScore ?? 0);
  const avgScore = scores.reduce((s, v) => s + v, 0) / scores.length;
  const high = positions.filter((p) => (p.adherenceScore ?? 0) >= 80);
  const low  = positions.filter((p) => (p.adherenceScore ?? 0) <  50);

  const violationCounts = new Map<string, number>();
  for (const p of positions) {
    if (!p.adherenceDetail) continue;
    try {
      const results = JSON.parse(p.adherenceDetail) as any[];
      for (const r of results) {
        if (r.outcome === 'failed') {
          violationCounts.set(r.ruleLabel, (violationCounts.get(r.ruleLabel) ?? 0) + 1);
        }
      }
    } catch { /* skip malformed */ }
  }

  let mostViolatedRule: { label: string; count: number } | null = null;
  for (const [label, count] of violationCounts) {
    if (!mostViolatedRule || count > mostViolatedRule.count) mostViolatedRule = { label, count };
  }

  const winRate = (arr: typeof positions) =>
    arr.length > 0 ? arr.filter((p) => (p.aggregatePnl ?? 0) > 0).length / arr.length : null;

  return {
    playbookName: playbook.name,
    sampleSize: positions.length,
    avgAdherenceScore: Math.round(avgScore),
    highAdherenceCount: high.length,
    lowAdherenceCount: low.length,
    highAdherenceWinRate: winRate(high),
    lowAdherenceWinRate: winRate(low),
    mostViolatedRule,
    notEnoughData: false,
  };
}

// ─── New read tools: Period Comparison ─────────────────────────────────────

export async function comparePeriods(
  wallet: string,
  period1: { from: string; to: string },
  period2: { from: string; to: string },
  journalId?: string,
): Promise<{ period1Stats: any; period2Stats: any; comparison: any }> {
  function computeStats(positions: { aggregatePnl: number | null; status: string }[]) {
    const closed = positions.filter((p) => p.status === 'closed');
    if (closed.length === 0) return { tradeCount: 0, winRate: 0, expectancy: 0, totalPnl: 0 };
    const totalPnl = closed.reduce((s, p) => s + (p.aggregatePnl ?? 0), 0);
    return {
      tradeCount: closed.length,
      winRate: Math.round((closed.filter((p) => (p.aggregatePnl ?? 0) > 0).length / closed.length) * 10000) / 10000,
      expectancy: Math.round((totalPnl / closed.length) * 100) / 100,
      totalPnl: Math.round(totalPnl * 100) / 100,
    };
  }

  const base: any = { walletAddress: wallet };
  if (journalId) base.journalId = journalId;

  const [positions1, positions2] = await Promise.all([
    prisma.position.findMany({
      where: { ...base, firstEntryTime: { gte: new Date(period1.from), lte: new Date(period1.to) } },
      select: { aggregatePnl: true, status: true },
    }),
    prisma.position.findMany({
      where: { ...base, firstEntryTime: { gte: new Date(period2.from), lte: new Date(period2.to) } },
      select: { aggregatePnl: true, status: true },
    }),
  ]);

  const p1 = computeStats(positions1);
  const p2 = computeStats(positions2);

  return {
    period1Stats: { ...p1, from: period1.from, to: period1.to },
    period2Stats: { ...p2, from: period2.from, to: period2.to },
    comparison: {
      winRateDelta: Math.round((p2.winRate - p1.winRate) * 10000) / 10000,
      expectancyDelta: Math.round((p2.expectancy - p1.expectancy) * 100) / 100,
      pnlDelta: Math.round((p2.totalPnl - p1.totalPnl) * 100) / 100,
      tradeCountDelta: p2.tradeCount - p1.tradeCount,
      improved: p2.expectancy > p1.expectancy,
    },
  };
}

// ─── New read tools: Risk Assessment ───────────────────────────────────────

export async function assessOpenPositionRisk(wallet: string): Promise<{
  totalExposure: number;
  positionCount: number;
  correlationWarning: boolean;
  largestPosition: { asset: string; size: number; pctOfEquity: number } | null;
  marginUtilization: number | null;
}> {
  const positions = await prisma.position.findMany({
    where: { walletAddress: wallet, status: 'open' },
    select: { asset: true, direction: true, totalSize: true, averageEntryPrice: true },
  });

  if (positions.length === 0) {
    return { totalExposure: 0, positionCount: 0, correlationWarning: false, largestPosition: null, marginUtilization: null };
  }

  const positionSizes = positions.map((p) => ({
    asset: p.asset,
    direction: (p.direction ?? '').toLowerCase(),
    notional: (p.totalSize ?? 0) * (p.averageEntryPrice ?? 0),
  }));

  const totalExposure = positionSizes.reduce((s, p) => s + p.notional, 0);

  const directions = new Set(positionSizes.map((p) => p.direction));
  const correlationWarning = positions.length > 1 && directions.size === 1;

  const sorted = [...positionSizes].sort((a, b) => b.notional - a.notional);
  const largest = sorted[0];

  let marginUtilization: number | null = null;
  let accountEquity: number | null = null;

  try {
    const base = process.env.PACIFICA_CARRY_API_URL
      ?? process.env.NEXT_PUBLIC_PACIFICA_API_URL
      ?? 'https://api.pacifica.fi';
    const res = await fetch(`${base}/api/v1/account?account=${wallet}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      const json: any = await res.json();
      const data = json?.data ?? json;
      if (data?.margin_utilization != null) marginUtilization = Number(data.margin_utilization);
      if (data?.equity != null) accountEquity = Number(data.equity);
    }
  } catch { /* degrade gracefully */ }

  const pctOfEquity =
    accountEquity != null && accountEquity > 0
      ? Math.round((largest.notional / accountEquity) * 1000) / 10
      : -1; // -1 = unknown

  return {
    totalExposure: Math.round(totalExposure * 100) / 100,
    positionCount: positions.length,
    correlationWarning,
    largestPosition: {
      asset: largest.asset,
      size: Math.round(largest.notional * 100) / 100,
      pctOfEquity,
    },
    marginUtilization,
  };
}

// ─── New write tools: Create entities ──────────────────────────────────────

export async function createSignalFromChat(
  wallet: string,
  params: {
    asset: string;
    direction: string;
    entryPrice: number;
    targetPrices?: number[];
    stopPrice?: number;
    callerName: string;
    source?: string;
  },
): Promise<{ signal: any }> {
  const targetPricesArray =
    params.targetPrices && params.targetPrices.length > 0 ? params.targetPrices : null;

  const signal = await prisma.signal.create({
    data: {
      walletAddress: wallet,
      asset: params.asset.toUpperCase(),
      direction: params.direction.toUpperCase(),
      entryPrice: params.entryPrice,
      targetPrice: targetPricesArray ? targetPricesArray[0] : null,
      targetPrices: targetPricesArray ? JSON.stringify(targetPricesArray) : null,
      stopPrice: params.stopPrice ?? null,
      callerName: params.callerName,
      source: params.source ?? 'booba_chat',
      status: 'open',
    },
  });

  return { signal };
}

export async function createPlaybookFromChat(
  wallet: string,
  params: {
    name: string;
    description?: string;
    rules: { type: string; params: Record<string, any>; enabled: boolean; label: string }[];
  },
): Promise<{ playbook: any }> {
  const playbook = await prisma.playbook.create({
    data: {
      walletAddress: wallet,
      name: params.name,
      description: params.description ?? null,
      rules: JSON.stringify(params.rules),
    },
  });

  return { playbook };
}

// ─── New action tools: UI manipulation ─────────────────────────────────────

export function navigateTo(params: {
  page: string;
  tab?: string;
}): { navigated: true; destination: string; page: string; tab?: string } {
  return {
    navigated: true,
    destination: params.tab ? `${params.page}?tab=${params.tab}` : params.page,
    page: params.page,
    ...(params.tab ? { tab: params.tab } : {}),
  };
}

export function setTradesFilter(
  _wallet: string,
  params: {
    direction?: string;
    assets?: string[];
    regimes?: string[];
    pnlFilter?: string;
    dateFrom?: string;
    dateTo?: string;
    strategy?: string;
    playbook?: string;
  },
): { applied: true; description: string; filter: typeof params } {
  const parts: string[] = [];
  if (params.direction) parts.push(`${params.direction.toLowerCase()} only`);
  if (params.assets?.length) parts.push(`assets: ${params.assets.join(', ')}`);
  if (params.regimes?.length) parts.push(`regimes: ${params.regimes.join(', ')}`);
  if (params.pnlFilter && params.pnlFilter !== 'all') parts.push(params.pnlFilter);
  if (params.dateFrom || params.dateTo) {
    const from = params.dateFrom ?? 'start';
    const to = params.dateTo ?? 'now';
    parts.push(`${from} to ${to}`);
  }
  if (params.strategy) parts.push(`strategy: ${params.strategy}`);
  if (params.playbook) parts.push(`playbook: ${params.playbook}`);

  return {
    applied: true,
    description: parts.length > 0 ? parts.join(', ') : 'all trades',
    filter: params,
  };
}
