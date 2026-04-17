import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Fill } from '@/services/grouping/types';
import { FillToOrderLevel } from '@/services/grouping/levels/fill-to-order';

// ─── Mock prisma + journals before importing the service under test ──────────
//
// The real prisma client opens a SQLite file at import time, and
// ensureDefaultJournal does its own DB reads/writes — neither is safe in a
// unit test. We build a tiny stub with just the methods the service calls
// along the code paths exercised here.

const prismaStub = {
  trade: {
    findMany: vi.fn(),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
  position: {
    findMany: vi.fn().mockResolvedValue([]),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    create: vi.fn().mockResolvedValue({ id: 'pos-1' }),
  },
  orderGroup: {
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    create: vi.fn().mockResolvedValue({ id: 'og-1' }),
  },
  linkedStrategy: {
    count: vi.fn().mockResolvedValue(0),
  },
  journal: {
    findMany: vi.fn().mockResolvedValue([]),
  },
};

vi.mock('@/lib/prisma', () => ({ prisma: prismaStub }));
vi.mock('@/lib/journals', () => ({
  ensureDefaultJournal: vi.fn().mockResolvedValue({ id: 'journal-default' }),
}));

// Service imports must come after vi.mock so the module graph picks up stubs.
const { GroupingService } = await import('@/services/grouping/grouping-service');

function dbFill(over: Partial<Record<string, unknown>> & { id: string }): any {
  return {
    walletAddress: 'wallet-a',
    asset: 'SOL',
    direction: 'long',
    size: 1,
    entryPrice: 100,
    exitPrice: 110,
    entryTime: new Date('2025-01-01T00:00:00Z'),
    exitTime: new Date('2025-01-01T00:05:00Z'),
    pnlRealized: 10,
    fees: 0.1,
    fundingEarned: 0,
    fundingPaid: 0,
    holdTimeSeconds: 300,
    rawData: null,
    builderCode: null,
    subaccount: null,
    cause: null,
    tradeType: null,
    regimeAtEntry: null,
    sentimentAtEntry: null,
    ...over,
  };
}

describe('GroupingService.groupAllFills', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaStub.trade.updateMany.mockResolvedValue({ count: 0 });
    prismaStub.position.findMany.mockResolvedValue([]);
    prismaStub.position.deleteMany.mockResolvedValue({ count: 0 });
    prismaStub.position.create.mockResolvedValue({ id: 'pos-1' });
    prismaStub.orderGroup.deleteMany.mockResolvedValue({ count: 0 });
    prismaStub.orderGroup.create.mockResolvedValue({ id: 'og-1' });
    prismaStub.linkedStrategy.count.mockResolvedValue(0);
    prismaStub.journal.findMany.mockResolvedValue([]);
  });

  it('empty fill set → zeroed summary, no persistence attempted', async () => {
    prismaStub.trade.findMany.mockResolvedValueOnce([]);

    const summary = await new GroupingService().groupAllFills('wallet-a');

    expect(summary).toEqual({
      totalFills: 0,
      totalOrders: 0,
      totalPositions: 0,
      totalLinkedStrategies: 0,
      positionsByType: {},
      needsReview: 0,
    });
    expect(prismaStub.position.create).not.toHaveBeenCalled();
    expect(prismaStub.orderGroup.create).not.toHaveBeenCalled();
    expect(prismaStub.linkedStrategy.count).not.toHaveBeenCalled();
  });

  it('single fill → one order group and one position persisted', async () => {
    prismaStub.trade.findMany.mockResolvedValueOnce([dbFill({ id: 'fill-1' })]);

    const summary = await new GroupingService().groupAllFills('wallet-a');

    expect(prismaStub.position.create).toHaveBeenCalledTimes(1);
    expect(prismaStub.orderGroup.create).toHaveBeenCalledTimes(1);
    expect(summary.totalFills).toBe(1);
    expect(summary.totalOrders).toBe(1);
    expect(summary.totalPositions).toBe(1);
    expect(summary.totalLinkedStrategies).toBe(0);

    // Persist path must link the fill to the created order group.
    expect(prismaStub.trade.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['fill-1'] } },
        data: { orderGroupId: 'og-1' },
      }),
    );
  });

  it('progress callback fires with a percentage and a message', async () => {
    prismaStub.trade.findMany.mockResolvedValueOnce([dbFill({ id: 'fill-1' })]);
    const onProgress = vi.fn();

    await new GroupingService().groupAllFills('wallet-a', onProgress);

    expect(onProgress).toHaveBeenCalled();
    const calls = onProgress.mock.calls;
    // Every call carries (percent: 0..100, message: non-empty string).
    for (const [percent, message] of calls) {
      expect(typeof percent).toBe('number');
      expect(percent).toBeGreaterThanOrEqual(0);
      expect(percent).toBeLessThanOrEqual(100);
      expect(typeof message).toBe('string');
      expect(message.length).toBeGreaterThan(0);
    }
    // The service emits a load-complete tick at 15%.
    expect(calls.some(([p]) => p === 15)).toBe(true);
  });
});

describe('FillToOrderLevel.group (shared order_id grouping)', () => {
  it('collapses fills sharing an order_id into a single OrderGroup', () => {
    const fills: Fill[] = [
      {
        id: 'f1',
        walletAddress: 'w',
        asset: 'SOL',
        direction: 'long',
        size: 1,
        entryPrice: 100,
        exitPrice: null,
        entryTime: new Date('2025-01-01T00:00:00Z'),
        exitTime: null,
        pnlRealized: null,
        fees: 0,
        fundingEarned: 0,
        fundingPaid: 0,
        holdTimeSeconds: null,
        rawData: JSON.stringify({ order_id: 42, side: 'open_long' }),
        builderCode: null,
        subaccount: null,
        cause: null,
        tradeType: null,
        regimeAtEntry: null,
        sentimentAtEntry: null,
      },
      {
        id: 'f2',
        walletAddress: 'w',
        asset: 'SOL',
        direction: 'long',
        size: 2,
        entryPrice: 101,
        exitPrice: null,
        entryTime: new Date('2025-01-01T00:00:01Z'),
        exitTime: null,
        pnlRealized: null,
        fees: 0,
        fundingEarned: 0,
        fundingPaid: 0,
        holdTimeSeconds: null,
        rawData: JSON.stringify({ order_id: 42, side: 'open_long' }),
        builderCode: null,
        subaccount: null,
        cause: null,
        tradeType: null,
        regimeAtEntry: null,
        sentimentAtEntry: null,
      },
      {
        id: 'f3',
        walletAddress: 'w',
        asset: 'SOL',
        direction: 'long',
        size: 1,
        entryPrice: 102,
        exitPrice: null,
        entryTime: new Date('2025-01-01T00:10:00Z'),
        exitTime: null,
        pnlRealized: null,
        fees: 0,
        fundingEarned: 0,
        fundingPaid: 0,
        holdTimeSeconds: null,
        rawData: JSON.stringify({ order_id: 99, side: 'open_long' }),
        builderCode: null,
        subaccount: null,
        cause: null,
        tradeType: null,
        regimeAtEntry: null,
        sentimentAtEntry: null,
      },
    ];

    const groups = new FillToOrderLevel().group(fills);
    // Two distinct order_ids → two order groups.
    expect(groups).toHaveLength(2);
    const sharedGroup = groups.find((g) => g.fills.length === 2);
    expect(sharedGroup).toBeDefined();
    expect(sharedGroup!.fills.map((f) => f.id).sort()).toEqual(['f1', 'f2']);
    // Multi-fill order groups are tagged partial_fill with full confidence.
    expect(sharedGroup!.tradeType).toBe('partial_fill');
    expect(sharedGroup!.confidence).toBe(1);
  });
});
