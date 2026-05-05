/**
 * Position enrichment from Pacifica order history.
 *
 * After fills are grouped into positions and orders are synced, this service
 * fills in five fields on each Position that the trade history alone can't
 * answer:
 *
 *   stopLossPrice      — price of the most recent active stop-loss order
 *   takeProfitPrice    — price of the most recent active take-profit order
 *   entryOrderType     — Pacifica order_type of the position's entry order
 *   hasPlannedStop     — true when an active SL existed for this position
 *   hasPlannedTarget   — true when an active TP existed for this position
 *
 * Linking strategy:
 *   1. Primary: SL/TP child orders carry stop_parent_order_id pointing at the
 *      entry order. We look up children whose parent ∈ the position's order
 *      ids. This is the definitive link — no symbol/time guessing.
 *   2. Fallback: when the parent link is missing (TPSL set after entry via
 *      /positions/tpsl, or order placed standalone), scan reduce-only SL/TP
 *      orders on the same symbol in the position's lifetime window.
 *
 * Orders with status 'cancelled' or 'rejected' are excluded — only active or
 * filled stops count toward hasPlannedStop / hasPlannedTarget. When multiple
 * active stops exist (a stop was moved or replaced), the most recent one wins.
 *
 * The whole job batch-loads orders + positions for the wallet and matches in
 * memory: O(orders + positions) round-trips, not O(positions × orders).
 */

import { prisma } from '../../lib/prisma';

type OrderRow = Awaited<ReturnType<typeof prisma.order.findMany>>[number];

// Pacifica order_type strings recognised as planned brackets. Only orders
// explicitly labelled stop_loss_* / take_profit_* count — generic stop_market
// orders aren't necessarily user-intended stop losses.
const SL_TYPES = new Set(['stop_loss_market', 'stop_loss_limit']);
const TP_TYPES = new Set(['take_profit_market', 'take_profit_limit']);

// Statuses that mean the stop never actually protected the position.
const INACTIVE_STATUSES = new Set(['cancelled', 'rejected']);

export interface EnrichmentResult {
  positionsConsidered: number;
  positionsUpdated: number;
  errors: string[];
}

export async function enrichPositionsFromOrders(
  walletAddress: string,
): Promise<EnrichmentResult> {
  const result: EnrichmentResult = {
    positionsConsidered: 0,
    positionsUpdated: 0,
    errors: [],
  };

  const orders = await prisma.order.findMany({ where: { walletAddress } });
  if (orders.length === 0) {
    console.log(`[enrich] no orders for ${walletAddress} — skipping`);
    return result;
  }

  // Index 1: orderId → Order (entry-order lookup).
  const ordersById = new Map<string, OrderRow>();
  // Index 2: parent orderId → child orders (primary SL/TP linkage).
  const ordersByParent = new Map<string, OrderRow[]>();
  // Index 3: symbol → reduce-only SL/TP orders sorted by createdAt asc
  //          (time-window fallback).
  const slTpBySymbol = new Map<string, OrderRow[]>();

  for (const o of orders) {
    ordersById.set(o.orderId.toString(), o);
    if (o.stopParentOrderId != null) {
      const key = o.stopParentOrderId.toString();
      const list = ordersByParent.get(key) ?? [];
      list.push(o);
      ordersByParent.set(key, list);
    }
    const isBracket = SL_TYPES.has(o.orderType) || TP_TYPES.has(o.orderType);
    if (isBracket && o.reduceOnly) {
      const list = slTpBySymbol.get(o.symbol) ?? [];
      list.push(o);
      slTpBySymbol.set(o.symbol, list);
    }
  }
  for (const list of slTpBySymbol.values()) {
    list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  const positions = await prisma.position.findMany({
    where: { walletAddress },
    select: {
      id: true,
      asset: true,
      firstEntryTime: true,
      lastExitTime: true,
      orderGroups: {
        select: {
          trades: { select: { orderId: true } },
        },
      },
    },
  });
  result.positionsConsidered = positions.length;

  for (const position of positions) {
    try {
      const positionOrderIds = new Set<string>();
      for (const og of position.orderGroups) {
        for (const t of og.trades) {
          if (t.orderId != null) positionOrderIds.add(t.orderId.toString());
        }
      }

      let entryOrder: OrderRow | null = null;
      for (const oid of positionOrderIds) {
        const o = ordersById.get(oid);
        if (!o) continue;
        if (!entryOrder || o.createdAt < entryOrder.createdAt) entryOrder = o;
      }

      // Primary linkage: SL/TPs whose parent is one of this position's orders.
      const candidates: OrderRow[] = [];
      for (const oid of positionOrderIds) {
        const children = ordersByParent.get(oid);
        if (children) candidates.push(...children);
      }
      let active = candidates.filter((o) => !INACTIVE_STATUSES.has(o.orderStatus));

      // Fallback: time-window scan over reduce-only bracket orders for the same
      // symbol. Only used when parent linkage produced nothing — re-entries on
      // the same asset overlap in time and would mis-attribute otherwise.
      if (active.length === 0) {
        const windowStart = position.firstEntryTime?.getTime() ?? -Infinity;
        const windowEnd = (position.lastExitTime ?? new Date()).getTime();
        const symbolList = slTpBySymbol.get(position.asset) ?? [];
        for (const o of symbolList) {
          const t = o.createdAt.getTime();
          if (t >= windowStart && t <= windowEnd && !INACTIVE_STATUSES.has(o.orderStatus)) {
            active.push(o);
          }
        }
      }

      // Most recent first — replaced/moved stops should win over earlier ones.
      active.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const slOrder = active.find((o) => SL_TYPES.has(o.orderType)) ?? null;
      const tpOrder = active.find((o) => TP_TYPES.has(o.orderType)) ?? null;

      await prisma.position.update({
        where: { id: position.id },
        data: {
          stopLossPrice: slOrder?.stopPrice ?? null,
          takeProfitPrice: tpOrder?.stopPrice ?? null,
          entryOrderType: entryOrder?.orderType ?? null,
          hasPlannedStop: slOrder != null,
          hasPlannedTarget: tpOrder != null,
        },
      });
      result.positionsUpdated++;
    } catch (err) {
      result.errors.push(`position ${position.id}: ${String(err)}`);
    }
  }

  console.log(
    `[enrich] ${result.positionsUpdated}/${result.positionsConsidered} positions enriched for ${walletAddress}`,
  );
  return result;
}
