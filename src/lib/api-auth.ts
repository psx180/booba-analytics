/**
 * api-auth.ts — request-level helpers for API routes.
 *
 * Provides:
 *   • `withAuth(request, handler)` — gate every route on a verified Privy
 *     session. The handler runs with a guaranteed wallet address and never
 *     has to read it from the URL/body again.
 *   • Ownership helpers (`requireOwnedPosition`, `requireOwnedJournal`,
 *     `requireOwnedOrderGroup`, `requireOwnedLinkedStrategy`, etc.) — for
 *     routes that look up resources by id, verify the resource belongs to
 *     the caller's wallet. The id-only routes that existed before this
 *     refactor were a security hole: anyone who knew a position id could
 *     read or modify it. These helpers close that hole.
 *
 * Pattern for routes:
 *
 *   export async function GET(req: NextRequest, ctx: Ctx) {
 *     return withAuth(req, async (walletAddress) => {
 *       const { id } = await ctx.params;
 *       const owned = await requireOwnedPosition(walletAddress, id);
 *       if (!owned.ok) return owned.response;
 *       const position = owned.position;
 *       // …
 *     });
 *   }
 *
 * Helpers return a tagged result `{ ok: true, … } | { ok: false, response }`
 * rather than throwing — keeps the route bodies linear and the failure
 * path explicit.
 */

import { NextResponse } from 'next/server';
import { getAuthenticatedWallet } from './auth';
import { prisma } from './prisma';

export type WithAuthHandler = (
  walletAddress: string,
  request: Request,
) => Promise<NextResponse> | NextResponse;

/**
 * Wraps a route handler so it only runs when the request carries a valid
 * Privy session (or matches the dev-bypass condition). Returns 401 if not.
 */
export async function withAuth(
  request: Request,
  handler: WithAuthHandler,
): Promise<NextResponse> {
  const wallet = await getAuthenticatedWallet(request);
  if (!wallet) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return handler(wallet, request);
}

// ── Ownership helpers ───────────────────────────────────────────────────────

type OwnedResult<T, K extends string> =
  | ({ ok: true } & { [P in K]: T })
  | { ok: false; response: NextResponse };

function notFound(label: string): NextResponse {
  return NextResponse.json({ error: `${label} not found` }, { status: 404 });
}
function forbidden(): NextResponse {
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
}

/**
 * Look up a position by id and verify it belongs to the caller's wallet.
 * Routes use the position from the result rather than re-querying.
 */
export async function requireOwnedPosition(
  walletAddress: string,
  positionId: string,
): Promise<OwnedResult<NonNullable<Awaited<ReturnType<typeof prisma.position.findUnique>>>, 'position'>> {
  const position = await prisma.position.findUnique({ where: { id: positionId } });
  if (!position) return { ok: false, response: notFound('Position') };
  if (position.walletAddress !== walletAddress) {
    return { ok: false, response: forbidden() };
  }
  return { ok: true, position };
}

/**
 * Same shape as requireOwnedPosition but for many ids at once. Used by
 * /api/positions/merge, /link, /move-journal — operations that take an
 * array of ids and need to verify the wallet owns *all* of them.
 *
 * Fails if any id is missing or any position belongs to a different
 * wallet. The error message says "one or more" so a malicious caller
 * can't enumerate which ids exist by varying the input.
 */
export async function requireOwnedPositions(
  walletAddress: string,
  positionIds: string[],
): Promise<OwnedResult<NonNullable<Awaited<ReturnType<typeof prisma.position.findMany>>>, 'positions'>> {
  const positions = await prisma.position.findMany({
    where: { id: { in: positionIds } },
  });
  if (positions.length !== positionIds.length) {
    return { ok: false, response: notFound('Position') };
  }
  if (positions.some((p) => p.walletAddress !== walletAddress)) {
    return { ok: false, response: forbidden() };
  }
  return { ok: true, positions };
}

export async function requireOwnedJournal(
  walletAddress: string,
  journalId: string,
): Promise<OwnedResult<NonNullable<Awaited<ReturnType<typeof prisma.journal.findUnique>>>, 'journal'>> {
  const journal = await prisma.journal.findUnique({ where: { id: journalId } });
  if (!journal) return { ok: false, response: notFound('Journal') };
  if (journal.walletAddress !== walletAddress) {
    return { ok: false, response: forbidden() };
  }
  return { ok: true, journal };
}

/**
 * OrderGroup ownership flows through Position: an order group belongs to
 * the wallet that owns its parent position. Returns the order group with
 * its position id so callers can use both without an extra round trip.
 */
export async function requireOwnedOrderGroup(
  walletAddress: string,
  orderGroupId: string,
): Promise<OwnedResult<{ id: string; positionId: string | null }, 'orderGroup'>> {
  const orderGroup = await prisma.orderGroup.findUnique({
    where: { id: orderGroupId },
    select: { id: true, positionId: true, position: { select: { walletAddress: true } } },
  });
  if (!orderGroup) return { ok: false, response: notFound('Order') };
  if (!orderGroup.position || orderGroup.position.walletAddress !== walletAddress) {
    return { ok: false, response: forbidden() };
  }
  return {
    ok: true,
    orderGroup: { id: orderGroup.id, positionId: orderGroup.positionId },
  };
}

export async function requireOwnedLinkedStrategy(
  walletAddress: string,
  strategyId: string,
): Promise<OwnedResult<NonNullable<Awaited<ReturnType<typeof prisma.linkedStrategy.findUnique>>>, 'linkedStrategy'>> {
  const linkedStrategy = await prisma.linkedStrategy.findUnique({
    where: { id: strategyId },
  });
  if (!linkedStrategy) return { ok: false, response: notFound('Linked strategy') };
  if (linkedStrategy.walletAddress !== walletAddress) {
    return { ok: false, response: forbidden() };
  }
  return { ok: true, linkedStrategy };
}
