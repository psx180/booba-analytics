import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

// api-auth.ts imports prisma at module load; mock it so the real client
// (which opens a SQLite file) never runs during tests.
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

const getAuthenticatedWallet = vi.fn();
vi.mock('@/lib/auth', () => ({ getAuthenticatedWallet }));

const { withAuth } = await import('@/lib/api-auth');

function makeRequest(): Request {
  return new Request('https://example.test/api/ping');
}

describe('withAuth', () => {
  beforeEach(() => {
    getAuthenticatedWallet.mockReset();
  });

  it('valid session: handler runs with the resolved wallet and its response flows through', async () => {
    getAuthenticatedWallet.mockResolvedValue('wallet-xyz');
    const handler = vi.fn(async (wallet: string) =>
      NextResponse.json({ ok: true, wallet }, { status: 200 }),
    );

    const res = await withAuth(makeRequest(), handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toBe('wallet-xyz');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, wallet: 'wallet-xyz' });
  });

  it('missing session: returns 401 JSON without invoking the handler', async () => {
    getAuthenticatedWallet.mockResolvedValue(null);
    const handler = vi.fn();

    const res = await withAuth(makeRequest(), handler);

    expect(handler).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('handler errors propagate (they are not swallowed into a 401)', async () => {
    getAuthenticatedWallet.mockResolvedValue('wallet-xyz');
    const boom = new Error('db exploded');
    const handler = vi.fn(async () => { throw boom; });

    await expect(withAuth(makeRequest(), handler)).rejects.toBe(boom);
  });

  it('handler may return a NextResponse synchronously', async () => {
    getAuthenticatedWallet.mockResolvedValue('wallet-xyz');
    const handler = vi.fn((_wallet: string) =>
      NextResponse.json({ sync: true }, { status: 202 }),
    );

    const res = await withAuth(makeRequest(), handler);
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ sync: true });
  });
});
