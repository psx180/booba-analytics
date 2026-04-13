/**
 * middleware.ts — CORS for extension and localhost origins on /api/* routes.
 *
 * Chrome extension content scripts make cross-origin requests to the journal
 * API (strategies, positions, SSE). The browser enforces CORS, so the server
 * must echo the Allow-Origin header. This middleware handles:
 *   - OPTIONS preflight — returns 204 with CORS headers so the browser
 *     proceeds with the actual request.
 *   - All other methods — injects CORS headers onto the pass-through response
 *     so the browser lets the content script read the body.
 *
 * Only chrome-extension:// origins and localhost are allowed. All other
 * origins go through unchanged (handled by Privy auth as normal).
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

function isAllowedOrigin(origin: string): boolean {
  return (
    origin.startsWith('chrome-extension://') ||
    /^https?:\/\/localhost(:\d+)?$/.test(origin)
  );
}

export function middleware(req: NextRequest) {
  const origin = req.headers.get('origin') ?? '';

  if (!isAllowedOrigin(origin)) return NextResponse.next();

  const corsHeaders: Record<string, string> = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, PATCH, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-bot-api-key',
    'Access-Control-Max-Age': '86400',
  };

  // Preflight — respond immediately; don't forward to the route handler.
  if (req.method === 'OPTIONS') {
    return new NextResponse(null, { status: 204, headers: corsHeaders });
  }

  const response = NextResponse.next();
  for (const [key, value] of Object.entries(corsHeaders)) {
    response.headers.set(key, value);
  }
  return response;
}

export const config = {
  matcher: '/api/:path*',
};
