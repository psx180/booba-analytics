/**
 * GET  /api/signals — List signals for the authenticated wallet
 * POST /api/signals — Create a new signal
 *
 * POST also accepts bot auth: if `x-bot-api-key` matches BOT_API_KEY env var,
 * Privy auth is skipped and DEFAULT_WALLET_ADDRESS is used as the wallet.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { prisma } from '@/lib/prisma';

/**
 * Resolve the wallet address for a request, preferring bot API key auth over
 * Privy. Returns null if neither path authenticates.
 *
 * Bot auth is only enabled when BOT_API_KEY is set in the environment —
 * if the env var is absent, bot key headers are ignored and Privy is required.
 */
async function resolveBotOrPrivy(
  req: NextRequest,
  handler: (walletAddress: string) => Promise<NextResponse>,
): Promise<NextResponse> {
  const botKey = process.env.BOT_API_KEY;
  const defaultWallet = process.env.DEFAULT_WALLET_ADDRESS;

  if (botKey && defaultWallet) {
    const provided = req.headers.get('x-bot-api-key');
    if (provided === botKey) {
      return handler(defaultWallet);
    }
  }

  return withAuth(req, handler);
}

// ── GET ─────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status') ?? undefined;
    const caller = searchParams.get('caller') ?? undefined;
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '50', 10), 200);

    const signals = await prisma.signal.findMany({
      where: {
        walletAddress,
        ...(status ? { status } : {}),
        ...(caller ? { callerName: caller } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    const total = await prisma.signal.count({
      where: {
        walletAddress,
        ...(status ? { status } : {}),
        ...(caller ? { callerName: caller } : {}),
      },
    });

    return NextResponse.json({ signals, total });
  });
}

// ── POST ────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  return resolveBotOrPrivy(req, async (walletAddress) => {
    let body: {
      asset: string;
      direction: string;
      entryPrice: number;
      targetPrice?: number | null;
      stopPrice?: number | null;
      callerName: string;
      source: string;
      channelName?: string | null;
      rawMessage?: string | null;
    };

    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (!body.asset || !body.direction || body.entryPrice == null || !body.callerName || !body.source) {
      return NextResponse.json(
        { error: 'asset, direction, entryPrice, callerName, and source are required' },
        { status: 400 },
      );
    }

    if (!['LONG', 'SHORT'].includes(body.direction)) {
      return NextResponse.json({ error: 'direction must be LONG or SHORT' }, { status: 400 });
    }

    const signal = await prisma.signal.create({
      data: {
        walletAddress,
        asset: body.asset.toUpperCase(),
        direction: body.direction,
        entryPrice: body.entryPrice,
        targetPrice: body.targetPrice ?? null,
        stopPrice: body.stopPrice ?? null,
        callerName: body.callerName,
        source: body.source,
        channelName: body.channelName ?? null,
        rawMessage: body.rawMessage ?? null,
        status: 'open',
      },
    });

    return NextResponse.json({ signal }, { status: 201 });
  });
}
