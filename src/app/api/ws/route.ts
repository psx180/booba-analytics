/**
 * GET /api/ws — Server-Sent Events bridge to the Pacifica websocket.
 *
 * The browser opens an EventSource to this endpoint; the server acquires
 * (or reuses) a per-wallet LiveSession that holds the upstream Pacifica
 * websocket and relays filtered events as SSE frames.
 *
 * Runtime: nodejs (not edge) because LiveSession uses the `ws` package,
 * which depends on Node's net module. force-dynamic disables the route
 * cache so each client gets a fresh stream.
 *
 * Event format (all JSON-encoded in `data:`):
 *   - open         — initial snapshot of open positions
 *   - status       — { connected: boolean }
 *   - new_trade    — fill detected, auto-imported and grouped
 *   - position_closed — a position transitioned to closed
 *   - price_update — unrealized P&L tick for open positions
 *   - error        — transient error (websocket, fill handler)
 */

import type { NextRequest } from 'next/server';
import { getAuthenticatedWallet } from '@/lib/auth';
import { acquireSession, releaseSession, type LiveEvent } from '@/services/pacifica/live/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const wallet = await getAuthenticatedWallet(req);
  if (!wallet) {
    return new Response('Unauthorized', { status: 401 });
  }

  const origin = req.headers.get('origin') ?? '';
  const allowCors =
    origin.startsWith('chrome-extension://') ||
    /^https?:\/\/localhost/.test(origin);

  const session = await acquireSession(wallet);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      const send = (event: LiveEvent) => {
        if (closed) return;
        try {
          const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
          controller.enqueue(encoder.encode(payload));
        } catch {
          // Client already disconnected — swallow; cleanup path handles teardown.
        }
      };

      // Keepalive comment every 20s to stop proxies from reaping the
      // connection during idle periods (Vercel defaults to 25s idle cutoff).
      const keepalive = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`));
        } catch {
          // ignore
        }
      }, 20_000);

      // Send the initial snapshot before wiring live events so the client
      // can render open positions immediately.
      send({ type: 'open', data: { positions: session.getOpenPositions() } });

      const listener = (event: LiveEvent) => send(event);
      session.on('event', listener);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        session.off('event', listener);
        releaseSession(wallet);
        try { controller.close(); } catch { /* ignore */ }
      };

      req.signal.addEventListener('abort', cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...(allowCors && { 'Access-Control-Allow-Origin': origin }),
    },
  });
}
