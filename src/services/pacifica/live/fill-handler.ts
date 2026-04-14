/**
 * fill-handler — processes a single `account_trades` event from the
 * Pacifica websocket.
 *
 * Pipeline per event:
 *   1. Dedupe by history_id against the DB (pacifica_fill_<history_id>).
 *   2. Insert via the same ingestion mapper used by the REST import, so
 *      the row shape is identical to a retroactive import.
 *   3. Incrementally group: attach to an existing open position on the
 *      same asset+direction, or create a new position.
 *   4. Fire-and-forget a fast-tier analytics recompute so the dashboard
 *      picks up the new row without waiting on regime tagging.
 *
 * The returned event object is what the SSE relay forwards to the
 * browser — kept small and serializable.
 */

import { prisma } from '../../../lib/prisma';
import { ingestTrades } from '../../ingestion';
import { fillId } from '../../ingestion/mapper';
import { GroupingService } from '../../grouping';
import { getTokenSocialContext } from '../../elfa/elfa-service';
import type { ElfaSocialContext } from '../../elfa/elfa-service';
import type { TradeHistoryEntry } from '../types/account';
import type { WsAccountTrade } from '../types/ws';

export interface NewTradeEvent {
  type: 'new_trade';
  data: {
    positionId: string;
    symbol: string;
    side: 'long' | 'short';
    amount: number;
    price: number;
    pnl: number | null;
    isNewPosition: boolean;
    sessionWarning?: {
      tradeNumber: number;
      optimalStop: number;
      avgPnlAfterOptimal: number;
    };
    socialContext?: ElfaSocialContext;
    regimeContext?: {
      currentRegime: string;
      assetRegimeWinRate: number;
      baselineWinRate: number;
      assetRegimeAvgPnl: number;
      tradeCountInRegime: number;
    };
  };
}

export interface PositionClosedEvent {
  type: 'position_closed';
  data: {
    positionId: string;
    symbol: string;
    side: 'long' | 'short';
    pnl: number;
  };
}

export type FillEvent = NewTradeEvent | PositionClosedEvent;

const groupingService = new GroupingService();

const DEFAULT_OPTIMAL_TRADES = 20;
const ONE_HOUR_MS = 60 * 60 * 1_000;
const MIN_REGIME_SAMPLE = 5;

/** Fetch the user's decision-fatigue optimal trade cutoff from the stored insight. */
async function fetchOptimalTradeCount(walletAddress: string): Promise<number> {
  try {
    const obs = await prisma.boobaObservation.findFirst({
      where: { walletAddress, sourceModule: 'time-of-day-edge', isActive: true },
      orderBy: { createdAt: 'desc' },
      select: { observationText: true },
    });
    if (!obs) return DEFAULT_OPTIMAL_TRADES;
    const insight = JSON.parse(obs.observationText) as {
      data?: { fatigue?: { optimalCutoff?: number; lateAvg?: number } };
    };
    return insight?.data?.fatigue?.optimalCutoff ?? DEFAULT_OPTIMAL_TRADES;
  } catch {
    return DEFAULT_OPTIMAL_TRADES;
  }
}

/** Look up the avg P&L after the optimal cutoff from the stored insight. */
async function fetchLateAvgPnl(walletAddress: string): Promise<number> {
  try {
    const obs = await prisma.boobaObservation.findFirst({
      where: { walletAddress, sourceModule: 'time-of-day-edge', isActive: true },
      orderBy: { createdAt: 'desc' },
      select: { observationText: true },
    });
    if (!obs) return 0;
    const insight = JSON.parse(obs.observationText) as {
      data?: { fatigue?: { lateAvg?: number } };
    };
    return insight?.data?.fatigue?.lateAvg ?? 0;
  } catch {
    return 0;
  }
}

/** Compute regime-conditional stats for a wallet + asset from closed positions. */
async function fetchRegimeContext(
  walletAddress: string,
  asset: string,
): Promise<NewTradeEvent['data']['regimeContext']> {
  try {
    // Use the most recent BTC regime snapshot as the market proxy.
    const snapshot = await prisma.regimeSnapshot.findFirst({
      where: { asset: 'BTC', timestamp: { lte: new Date() } },
      orderBy: { timestamp: 'desc' },
      select: { regimeClassification: true, timestamp: true },
    });
    if (!snapshot?.regimeClassification) return undefined;
    if (Date.now() - snapshot.timestamp.getTime() > ONE_HOUR_MS) return undefined;

    const currentRegime = snapshot.regimeClassification;

    const [allClosed, assetRegimeClosed] = await Promise.all([
      prisma.position.findMany({
        where: { walletAddress, status: 'closed' },
        select: { aggregatePnl: true },
      }),
      prisma.position.findMany({
        where: { walletAddress, asset, regimeAtEntry: currentRegime, status: 'closed' },
        select: { aggregatePnl: true },
      }),
    ]);

    if (allClosed.length === 0 || assetRegimeClosed.length < MIN_REGIME_SAMPLE) return undefined;

    const baselineWinRate =
      (allClosed.filter((p) => (p.aggregatePnl ?? 0) > 0).length / allClosed.length) * 100;
    const assetRegimeWinRate =
      (assetRegimeClosed.filter((p) => (p.aggregatePnl ?? 0) > 0).length /
        assetRegimeClosed.length) *
      100;
    const assetRegimeAvgPnl =
      assetRegimeClosed.reduce((s, p) => s + (p.aggregatePnl ?? 0), 0) /
      assetRegimeClosed.length;

    return {
      currentRegime,
      assetRegimeWinRate,
      baselineWinRate,
      assetRegimeAvgPnl,
      tradeCountInRegime: assetRegimeClosed.length,
    };
  } catch {
    return undefined;
  }
}

export async function handleAccountTrade(
  walletAddress: string,
  raw: WsAccountTrade['data'],
  sessionTradeNumber = 1,
): Promise<FillEvent[]> {
  if (raw.history_id == null) return [];

  // Shape the WS payload into the REST TradeHistoryEntry contract so the
  // existing mapper/ingestor handles it without branching. The WS payload
  // lacks `cause` — live fills are never liquidation acquisitions, so
  // 'trade' falls through to 'directional' in causeToTradeType.
  const entry: TradeHistoryEntry = {
    history_id: raw.history_id,
    order_id: raw.order_id ?? 0,
    client_order_id: raw.client_order_id ?? null,
    symbol: raw.symbol,
    amount: raw.amount,
    price: raw.price,
    entry_price: raw.entry_price ?? raw.price,
    fee: raw.fee ?? '0',
    pnl: raw.pnl ?? '0',
    event_type: raw.event_type,
    side: raw.side,
    created_at: raw.created_at,
    cause: 'trade',
  };

  const id = fillId(entry);
  // Targeted lookup — O(1) on the indexed primary key, vs. scanning every
  // fill in the DB like getExistingFillIds() does for the bulk import path.
  const existing = await prisma.trade.findUnique({ where: { id }, select: { id: true } });
  if (existing) return [];

  const result = await ingestTrades([entry], walletAddress);
  if (result.tradesUpserted === 0) return [];

  const grouped = await groupingService.groupNewFill(walletAddress, id);
  if (!grouped) return [];

  const events: FillEvent[] = [];
  const side: 'long' | 'short' = entry.side.includes('long') ? 'long' : 'short';

  // ── Enrichment (session fatigue + regime context) ──────────────────────
  // Both run in parallel and fail gracefully — a thrown error just skips
  // the enrichment rather than blocking the trade event.
  const [optimalStop, lateAvgPnl, regimeContext, socialContext] = await Promise.all([
    fetchOptimalTradeCount(walletAddress),
    fetchLateAvgPnl(walletAddress),
    fetchRegimeContext(walletAddress, entry.symbol),
    getTokenSocialContext(entry.symbol).catch(() => null),
  ]);

  const sessionWarning: NewTradeEvent['data']['sessionWarning'] =
    sessionTradeNumber > optimalStop
      ? { tradeNumber: sessionTradeNumber, optimalStop, avgPnlAfterOptimal: lateAvgPnl }
      : undefined;

  console.log(
    `[live] Trade #${sessionTradeNumber} in session (optimal: ${optimalStop})`,
  );
  if (regimeContext) {
    console.log(
      `[live] Regime context: ${regimeContext.currentRegime}, asset win rate: ${regimeContext.assetRegimeWinRate.toFixed(1)}%`,
    );
  }

  events.push({
    type: 'new_trade',
    data: {
      positionId: grouped.positionId,
      symbol: entry.symbol,
      side,
      amount: parseFloat(entry.amount),
      price: parseFloat(entry.price),
      pnl: entry.pnl ? parseFloat(entry.pnl) : null,
      isNewPosition: grouped.isNewPosition,
      ...(sessionWarning && { sessionWarning }),
      ...(socialContext && { socialContext }),
      ...(regimeContext && { regimeContext }),
    },
  });

  // Store social context on the position — fire-and-forget
  if (socialContext) {
    prisma.position
      .update({
        where: { id: grouped.positionId },
        data: {
          socialSentiment: socialContext.sentimentScore,
          socialMentions: socialContext.mentionCount,
          socialMindshare: socialContext.mindshare,
        },
      })
      .catch((err) => console.warn('[live] Social enrichment failed:', err));
  }

  if (grouped.wasClosed) {
    const pos = await prisma.position.findUnique({ where: { id: grouped.positionId } });
    if (pos) {
      events.push({
        type: 'position_closed',
        data: {
          positionId: pos.id,
          symbol: pos.asset,
          side: pos.direction as 'long' | 'short',
          pnl: pos.aggregatePnl ?? 0,
        },
      });
    }
  }

  // Fire-and-forget fast-tier recompute so analytics reflect the new fill
  // without blocking the websocket event loop.
  import('../../compute-policy')
    .then(({ runCompute }) =>
      runCompute(walletAddress, 'mutation').catch((err) =>
        console.error('[live] runCompute failed', err),
      ),
    )
    .catch(() => {});

  // Fire-and-forget adherence check. Only runs if the position has been
  // tagged with a playbook — no-op otherwise. Scored and persisted so the
  // trade detail modal renders the breakdown without recomputing.
  import('../../playbooks/adherence-service')
    .then(({ runAndStoreAdherence }) =>
      runAndStoreAdherence(grouped.positionId).catch((err) =>
        console.error('[live] adherence check failed', err),
      ),
    )
    .catch(() => {});

  return events;
}
