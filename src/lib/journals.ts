/**
 * journals.ts
 *
 * Helpers for the multi-journal system. A journal is a slice of a wallet's
 * positions with its own analytics. Every wallet has exactly one default
 * journal ("All Trades") that is created lazily on first need.
 *
 * Resolution rules used by every API route:
 *   1. If the request specifies a journalId, validate it belongs to this
 *      wallet and use it directly.
 *   2. Otherwise, return the wallet's default journal id, creating one and
 *      adopting any orphan positions if it doesn't exist yet.
 *
 * Position rows with journalId == null are treated as members of the
 * default journal at query time. ensureDefaultJournal() backfills them onto
 * the default journal record so subsequent queries can use a strict equality
 * filter (cleaner than OR-ing in `null` everywhere).
 */

import { prisma } from './prisma';
import type { Journal } from '../../generated/prisma/client';

/**
 * Find or create the wallet's default journal. The first call for a wallet
 * also adopts any pre-existing positions that have no journalId — this is
 * how legacy data (imported before the multi-journal system existed) gets
 * folded into "All Trades" without a manual backfill.
 */
export async function ensureDefaultJournal(walletAddress: string): Promise<Journal> {
  const existing = await prisma.journal.findFirst({
    where: { walletAddress, isDefault: true },
  });
  if (existing) return existing;

  const created = await prisma.journal.create({
    data: {
      walletAddress,
      name: 'All Trades',
      description: 'Default journal — every position lives here unless moved.',
      isDefault: true,
    },
  });

  // Adopt orphan positions for this wallet so we never have to OR-on-null
  // when filtering. Future imports go straight to a journal so this is a
  // one-shot per wallet.
  await prisma.position.updateMany({
    where: { walletAddress, journalId: null },
    data: { journalId: created.id },
  });

  return created;
}

/**
 * Resolve a journalId for a request. If the caller provided one, validate it
 * belongs to this wallet (returns null on mismatch — the route should 404).
 * Otherwise fall back to the default journal.
 */
export async function resolveJournalId(
  walletAddress: string,
  requestedJournalId: string | null | undefined,
): Promise<string | null> {
  if (requestedJournalId) {
    const journal = await prisma.journal.findUnique({
      where: { id: requestedJournalId },
    });
    if (!journal || journal.walletAddress !== walletAddress) return null;
    return journal.id;
  }
  const def = await ensureDefaultJournal(walletAddress);
  return def.id;
}

/**
 * Same as resolveJournalId but for use in places that already know the
 * provided id is valid (e.g., chained from a previous resolve). Throws if
 * the journal doesn't exist for this wallet.
 */
export async function requireJournalId(
  walletAddress: string,
  requestedJournalId: string | null | undefined,
): Promise<string> {
  const id = await resolveJournalId(walletAddress, requestedJournalId);
  if (!id) throw new Error('Journal not found for wallet');
  return id;
}
