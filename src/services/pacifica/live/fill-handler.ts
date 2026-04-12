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

export async function handleAccountTrade(
  walletAddress: string,
  raw: WsAccountTrade['data'],
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
    },
  });

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

  return events;
}
