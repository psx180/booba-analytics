/**
 * POST /api/signals/webhook — TradingView alert webhook.
 *
 * Public endpoint — no Privy auth, no bot key. Secured by a shared secret in
 * the query string: ?secret=TRADINGVIEW_WEBHOOK_SECRET.
 *
 * Accepts JSON or plain text bodies from TradingView alerts.
 *
 * JSON fields:
 *   ticker       — asset symbol (BTCUSDT, BTC-PERP, etc.)
 *   action/side  — direction (buy/long/bid → LONG, sell/short/ask → SHORT)
 *   price/close  — entry price (string or number)
 *   tp           — take-profit price
 *   sl           — stop-loss price
 *   strategy     — caller name (falls back to "TradingView")
 *   alert_name   — alternative caller name
 *
 * Plain text format:
 *   BUY BTC 79000 TP:82000 SL:77000
 *
 * If TELEGRAM_NOTIFY_URL is set, the created signal is posted there
 * fire-and-forget so Telegram bots can alert the user.
 *
 * Returns: { success: true, signal: { id, asset, direction, entryPrice } }
 *
 * Test:
 *   curl -X POST "http://localhost:3000/api/signals/webhook?secret=your-secret" \
 *     -H "Content-Type: application/json" \
 *     -d '{"ticker":"BTCUSDT","action":"buy","price":"79000","tp":"82000","sl":"77000","strategy":"MA Crossover"}'
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

// ── Ticker normalisation ─────────────────────────────────────────────────────

/**
 * Strip exchange-specific suffixes and return the clean Pacifica-style symbol.
 * Examples: BTCUSDT→BTC, BTCUSD→BTC, BTC-PERP→BTC, ETH/USDT→ETH.
 */
function normaliseTicker(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[/\-.]?(USDT|USD|BUSD|PERP|SWAP|FUT|FUTURES?)$/i, '')
    .replace(/^(\w+?)(?:USDT|USD)$/i, '$1') // catch BTCUSDT without separator
    .trim();
}

// ── Direction normalisation ──────────────────────────────────────────────────

function normaliseDirection(raw: string): 'LONG' | 'SHORT' | null {
  const lower = raw.toLowerCase().trim();
  if (['buy', 'long', 'bid', 'bullish', 'bull'].includes(lower)) return 'LONG';
  if (['sell', 'short', 'ask', 'bearish', 'bear'].includes(lower)) return 'SHORT';
  return null;
}

// ── Plain text parser ────────────────────────────────────────────────────────

interface ParsedWebhookSignal {
  asset: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  targetPrice: number | null;
  stopPrice: number | null;
  callerName: string;
}

/**
 * Parse a structured plain text alert line, e.g.:
 *   BUY BTC 79000 TP:82000 SL:77000
 *   SHORT ETH 3200 SL:3350 TP:2900 strategy:MACross
 */
function parsePlainText(text: string): ParsedWebhookSignal | null {
  const tokens = text.trim().split(/\s+/);
  if (tokens.length < 3) return null;

  const direction = normaliseDirection(tokens[0]);
  if (!direction) return null;

  const asset = normaliseTicker(tokens[1]);
  if (!asset) return null;

  const entryPrice = parseFloat(tokens[2]);
  if (isNaN(entryPrice) || entryPrice <= 0) return null;

  let targetPrice: number | null = null;
  let stopPrice: number | null = null;
  let callerName = 'TradingView';

  // Remaining tokens may be TP:82000, SL:77000, strategy:Name
  for (let i = 3; i < tokens.length; i++) {
    const [key, val] = tokens[i].split(':');
    if (!val) continue;
    const lower = key.toLowerCase();
    if (lower === 'tp' || lower === 'target') {
      const n = parseFloat(val);
      if (!isNaN(n)) targetPrice = n;
    } else if (lower === 'sl' || lower === 'stop') {
      const n = parseFloat(val);
      if (!isNaN(n)) stopPrice = n;
    } else if (lower === 'strategy' || lower === 'name' || lower === 'caller') {
      callerName = val;
    }
  }

  return { asset, direction, entryPrice, targetPrice, stopPrice, callerName };
}

/**
 * Parse a JSON body from TradingView.
 */
function parseJsonBody(body: Record<string, unknown>): ParsedWebhookSignal | null {
  // Asset
  const rawTicker = body.ticker ?? body.symbol ?? body.asset;
  if (typeof rawTicker !== 'string' || !rawTicker) return null;
  const asset = normaliseTicker(rawTicker);

  // Direction
  const rawDirection = body.action ?? body.side ?? body.direction ?? body.signal;
  if (typeof rawDirection !== 'string') return null;
  const direction = normaliseDirection(rawDirection);
  if (!direction) return null;

  // Entry price
  const rawPrice = body.price ?? body.close ?? body.entry;
  const entryPrice = typeof rawPrice === 'number' ? rawPrice : parseFloat(String(rawPrice ?? ''));
  if (isNaN(entryPrice) || entryPrice <= 0) return null;

  // Optional TP/SL
  const rawTp = body.tp ?? body.take_profit ?? body.target;
  const targetPrice = rawTp != null ? parseFloat(String(rawTp)) : null;

  const rawSl = body.sl ?? body.stop_loss ?? body.stop;
  const stopPrice = rawSl != null ? parseFloat(String(rawSl)) : null;

  // Caller name
  const rawCaller = body.strategy ?? body.alert_name ?? body.name ?? body.caller;
  const callerName = typeof rawCaller === 'string' && rawCaller.trim()
    ? rawCaller.trim()
    : 'TradingView';

  return {
    asset,
    direction,
    entryPrice,
    targetPrice: targetPrice != null && !isNaN(targetPrice) ? targetPrice : null,
    stopPrice: stopPrice != null && !isNaN(stopPrice) ? stopPrice : null,
    callerName,
  };
}

// ── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // Secret validation
  const expectedSecret = process.env.TRADINGVIEW_WEBHOOK_SECRET;
  if (!expectedSecret) {
    return NextResponse.json(
      { error: 'Webhook not configured (TRADINGVIEW_WEBHOOK_SECRET not set)' },
      { status: 503 },
    );
  }

  const { searchParams } = new URL(req.url);
  const providedSecret = searchParams.get('secret');
  if (!providedSecret || providedSecret !== expectedSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Wallet target
  const walletAddress = process.env.DEFAULT_WALLET_ADDRESS;
  if (!walletAddress) {
    return NextResponse.json(
      { error: 'DEFAULT_WALLET_ADDRESS not configured' },
      { status: 503 },
    );
  }

  // Parse body — try JSON first, fall back to plain text
  const contentType = req.headers.get('content-type') ?? '';
  let parsed: ParsedWebhookSignal | null = null;

  if (contentType.includes('application/json')) {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    parsed = parseJsonBody(body);
  } else {
    // Plain text (TradingView sends text/plain for message-body alerts)
    const text = await req.text();
    parsed = parsePlainText(text.trim());
  }

  if (!parsed) {
    return NextResponse.json(
      { error: 'Could not extract a valid signal from the request body' },
      { status: 422 },
    );
  }

  // Create signal
  const signal = await prisma.signal.create({
    data: {
      walletAddress,
      asset: parsed.asset,
      direction: parsed.direction,
      entryPrice: parsed.entryPrice,
      targetPrice: parsed.targetPrice,
      stopPrice: parsed.stopPrice,
      callerName: parsed.callerName,
      source: 'tradingview',
      channelName: null,
      rawMessage: null,
      status: 'open',
    },
  });

  // Fire-and-forget Telegram notification
  const telegramUrl = process.env.TELEGRAM_NOTIFY_URL;
  if (telegramUrl) {
    fetch(telegramUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: signal.id,
        asset: signal.asset,
        direction: signal.direction,
        entryPrice: signal.entryPrice,
        targetPrice: signal.targetPrice,
        stopPrice: signal.stopPrice,
        callerName: signal.callerName,
        source: signal.source,
        createdAt: signal.createdAt,
      }),
    }).catch((err) => {
      console.error('[webhook] Telegram notify failed:', err.message);
    });
  }

  return NextResponse.json({
    success: true,
    signal: {
      id: signal.id,
      asset: signal.asset,
      direction: signal.direction,
      entryPrice: signal.entryPrice,
    },
  });
}
