/**
 * signal-parser.ts — Parse raw text into a structured trading signal.
 *
 * Sends the raw message to Claude with a tight system prompt that extracts
 * asset, direction, prices, and caller name. Returns a typed ParsedSignal or
 * null if the text doesn't contain a valid trading call.
 */

export interface ParsedSignal {
  asset: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  targetPrice: number | null;       // TP1 — first/primary target, for backward compat
  targetPrices: number[] | null;    // all targets, e.g. [110, 114, 120]
  stopPrice: number | null;
  callerName: string | null;
}

const SYSTEM_PROMPT = `You parse trading call messages into structured data. Extract:
- asset: the trading pair (BTC, ETH, SOL, etc.) — use the short symbol only, no "USDT" suffix
- direction: LONG or SHORT
- entryPrice: the suggested entry price (required)
- targetPrices: array of take-profit targets in order (if mentioned, otherwise null). Always return an array even for a single target.
- stopPrice: stop-loss level (if mentioned, otherwise null)
- callerName: who is making the call (if attributable from the message, otherwise null)

Respond ONLY with a JSON object. If the message is not a trading call, respond with {"is_signal": false}.

Example input: "Long SOL at 103, TP1: 110, TP2: 114, TP3: 120, stop 99 — @AlphaTrader"
Example output: {"is_signal": true, "asset": "SOL", "direction": "LONG", "entryPrice": 103, "targetPrices": [110, 114, 120], "stopPrice": 99, "callerName": "AlphaTrader"}

Example input: "Long BTC here at 79k, target 82k, stop 77k - @AlphaTrader"
Example output: {"is_signal": true, "asset": "BTC", "direction": "LONG", "entryPrice": 79000, "targetPrices": [82000], "stopPrice": 77000, "callerName": "AlphaTrader"}

Example input: "gm everyone, bullish vibes today"
Example output: {"is_signal": false}

Example input: "Short ETH 3200, SL 3350, TP 2900"
Example output: {"is_signal": true, "asset": "ETH", "direction": "SHORT", "entryPrice": 3200, "targetPrices": [2900], "stopPrice": 3350, "callerName": null}`;

export async function parseSignalFromText(text: string): Promise<ParsedSignal | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error ${response.status}: ${errText}`);
  }

  const result = await response.json();
  const textContent = (result.content || []).find((b: any) => b.type === 'text');
  if (!textContent) return null;

  let parsed: any;
  try {
    // Claude sometimes wraps the JSON in a code fence — strip it
    const raw = textContent.text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    parsed = JSON.parse(raw);
  } catch {
    console.error('[signal-parser] Failed to parse JSON from Claude:', textContent.text);
    return null;
  }

  if (!parsed.is_signal) return null;

  // Validate required fields
  if (!parsed.asset || !parsed.direction || parsed.entryPrice == null) return null;
  if (!['LONG', 'SHORT'].includes(parsed.direction)) return null;
  if (typeof parsed.entryPrice !== 'number' || parsed.entryPrice <= 0) return null;

  // Normalise targetPrices: accept array or legacy single targetPrice
  let targetPricesArray: number[] | null = null;
  if (Array.isArray(parsed.targetPrices) && parsed.targetPrices.length > 0) {
    const valid = parsed.targetPrices.filter((p: any) => typeof p === 'number' && p > 0);
    if (valid.length > 0) targetPricesArray = valid;
  } else if (typeof parsed.targetPrice === 'number' && parsed.targetPrice > 0) {
    targetPricesArray = [parsed.targetPrice];
  }

  return {
    asset: String(parsed.asset).toUpperCase(),
    direction: parsed.direction as 'LONG' | 'SHORT',
    entryPrice: parsed.entryPrice,
    targetPrice: targetPricesArray ? targetPricesArray[0] : null,
    targetPrices: targetPricesArray,
    stopPrice: typeof parsed.stopPrice === 'number' ? parsed.stopPrice : null,
    callerName: parsed.callerName ? String(parsed.callerName) : null,
  };
}
