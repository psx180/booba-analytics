/**
 * POST /api/signals/parse — Parse raw text into a structured signal via Claude.
 *
 * Request:  { text: string, source: string, channelName?: string, callerName?: string }
 * Response: { signal: ParsedSignal | null }
 *
 * If callerName is provided in the request body, it overrides whatever Claude
 * extracted from the message.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { parseSignalFromText } from '@/services/signals/signal-parser';

export async function POST(req: NextRequest) {
  return withAuth(req, async () => {
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
