/**
 * fire-mock-signal.ts — POST realistic mock alerts to the TradingView
 * webhook so signals stream into the live app the same way they would
 * during a real demo.
 *
 * This hits the same public endpoint TradingView itself would call
 * (/api/signals/webhook?secret=...), so no schema shortcuts — each
 * signal flows through normaliseTicker, normaliseDirection, the
 * Prisma create, and any Telegram fan-out.
 *
 * Usage:
 *   npx tsx src/scripts/fire-mock-signal.ts --count=5 --every=8s
 *   npx tsx src/scripts/fire-mock-signal.ts --url=https://your-deploy.example.com --count=3
 *   npx tsx src/scripts/fire-mock-signal.ts --once           # fire one signal and exit
 *   npx tsx src/scripts/fire-mock-signal.ts --format=text    # plain-text body instead of JSON
 *
 * Defaults:
 *   --url     http://localhost:3000
 *   --secret  process.env.TRADINGVIEW_WEBHOOK_SECRET
 *   --count   3
 *   --every   6s
 *   --format  json
 */

// Force TypeScript to treat this file as a module so top-level declarations
// (Args, main, etc.) don't collide with other scripts' globals during build.
export {};

interface Args {
  url: string;
  secret: string;
  count: number;
  intervalMs: number;
  format: 'json' | 'text';
}

const ASSETS = ['BTC', 'ETH', 'SOL'] as const;
type Asset = typeof ASSETS[number];

const PRICE_RANGES: Record<Asset, { min: number; max: number; decimals: number }> = {
  BTC: { min: 74000, max: 92000, decimals: 0 },
  ETH: { min: 2700,  max: 3700,  decimals: 0 },
  SOL: { min: 115,   max: 180,   decimals: 1 },
};

const CALLERS = [
  'MA Crossover',
  'EMA20 Pullback',
  'RSI Divergence',
  'Breakout Scanner',
  'Volume Spike',
];

// ── CLI parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Args {
  const args: Record<string, string> = {};
  const flags = new Set<string>();
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith('--')) continue;
    const body = raw.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) flags.add(body);
    else args[body.slice(0, eq)] = body.slice(eq + 1);
  }

  const url = (args.url ?? 'http://localhost:3000').replace(/\/$/, '');
  const secret = args.secret ?? process.env.TRADINGVIEW_WEBHOOK_SECRET ?? '';
  const count = flags.has('once') ? 1 : parseInt(args.count ?? '3', 10);
  const intervalMs = parseDuration(args.every ?? '6s');
  const format = (args.format ?? 'json') === 'text' ? 'text' : 'json';

  if (!secret) {
    console.error('Missing webhook secret. Set TRADINGVIEW_WEBHOOK_SECRET or pass --secret=<value>.');
    process.exit(1);
  }
  if (!Number.isFinite(count) || count < 1) {
    console.error('--count must be a positive integer.');
    process.exit(1);
  }

  return { url, secret, count, intervalMs, format };
}

// Accepts "6s", "500ms", "2m", or a bare number (milliseconds).
function parseDuration(raw: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(raw.trim());
  if (!match) {
    console.error(`Invalid duration "${raw}". Use forms like 500ms, 6s, 2m.`);
    process.exit(1);
  }
  const n = parseFloat(match[1]);
  const unit = match[2] ?? 'ms';
  if (unit === 'ms') return n;
  if (unit === 's')  return n * 1_000;
  return n * 60_000;
}

// ── Signal generation ───────────────────────────────────────────────────────

function randomBetween(min: number, max: number, decimals: number): number {
  const n = Math.random() * (max - min) + min;
  const pow = 10 ** decimals;
  return Math.round(n * pow) / pow;
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

interface MockSignal {
  ticker: string;
  action: 'buy' | 'sell';
  price: number;
  tp: number;
  sl: number;
  strategy: string;
}

function makeSignal(): MockSignal {
  const asset = pick(ASSETS);
  const range = PRICE_RANGES[asset];
  const action = Math.random() < 0.5 ? 'buy' : 'sell';
  const price = randomBetween(range.min, range.max, range.decimals);

  // Symmetric TP/SL around entry (2R target, 1R stop) with small jitter.
  const riskPct = randomBetween(0.015, 0.03, 4); // 1.5–3% stop distance
  const rewardMult = randomBetween(1.5, 3.0, 2);
  const tp = action === 'buy'
    ? round(price * (1 + riskPct * rewardMult), range.decimals)
    : round(price * (1 - riskPct * rewardMult), range.decimals);
  const sl = action === 'buy'
    ? round(price * (1 - riskPct), range.decimals)
    : round(price * (1 + riskPct), range.decimals);

  return { ticker: asset, action, price, tp, sl, strategy: pick(CALLERS) };
}

function round(n: number, decimals: number): number {
  const pow = 10 ** decimals;
  return Math.round(n * pow) / pow;
}

// ── HTTP send ───────────────────────────────────────────────────────────────

async function send(args: Args, signal: MockSignal): Promise<void> {
  const endpoint = `${args.url}/api/signals/webhook?secret=${encodeURIComponent(args.secret)}`;
  const headers: Record<string, string> = {};
  let body: string;
  if (args.format === 'json') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(signal);
  } else {
    headers['Content-Type'] = 'text/plain';
    const verb = signal.action === 'buy' ? 'BUY' : 'SELL';
    body = `${verb} ${signal.ticker} ${signal.price} TP:${signal.tp} SL:${signal.sl} strategy:${signal.strategy.replace(/\s+/g, '_')}`;
  }

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(endpoint, { method: 'POST', headers, body });
  } catch (err) {
    console.error(`  ✗ network error: ${(err as Error).message}`);
    return;
  }

  const ms = Date.now() - started;
  const arrow = signal.action === 'buy' ? '▲' : '▼';
  const summary = `${arrow} ${signal.ticker} ${signal.action.toUpperCase()} @ ${signal.price} TP:${signal.tp} SL:${signal.sl} (${signal.strategy})`;

  if (res.ok) {
    const json = await res.json().catch(() => null);
    const id = json?.signal?.id ? ` id=${json.signal.id}` : '';
    console.log(`  ✓ ${summary}${id} [${ms}ms]`);
  } else {
    const text = await res.text().catch(() => '');
    console.error(`  ✗ ${res.status} ${summary}: ${text}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  console.log(
    `Firing ${args.count} mock signal(s) → ${args.url}/api/signals/webhook`
    + (args.count > 1 ? ` every ${args.intervalMs}ms` : '')
    + ` (${args.format} body)`,
  );

  for (let i = 0; i < args.count; i++) {
    const signal = makeSignal();
    await send(args, signal);
    if (i < args.count - 1) {
      await new Promise((r) => setTimeout(r, args.intervalMs));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
