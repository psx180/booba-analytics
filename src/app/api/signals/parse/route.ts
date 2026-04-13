/**
 * POST /api/signals/parse — Parse raw text into a structured signal via Claude.
 *
 * Request:  { text: string, source: string, channelName?: string, callerName?: string }
 * Response: { signal: ParsedSignal | null }
 *
 * If callerName is provided in the request body, it overrides whatever Claude
 * extracted from the message.
 *
 * Also accepts bot auth: `x-bot-api-key` header matching BOT_API_KEY env var
 * bypasses Privy. Bot key is ignored if BOT_API_KEY is not set.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { parseSignalFromText } from '@/services/signals/signal-parser';

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

export async function POST(req: NextRequest) {
  return resolveBotOrPrivy(req, async () => {
    let body: {
      text: string;
      source?: string;
      channelName?: string;
      callerName?: string;
    };

    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (!body.text || typeof body.text !== 'string') {
      return NextResponse.json({ error: 'text is required' }, { status: 400 });
    }

    const parsed = await parseSignalFromText(body.text);

    if (!parsed) {
      return NextResponse.json({ signal: null });
    }

    // Caller name from request body overrides what Claude extracted
    if (body.callerName) {
      parsed.callerName = body.callerName;
    }

    return NextResponse.json({ signal: parsed });
  });
}
