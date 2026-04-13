'use client';

/**
 * TradeReplay — candlestick playback of the price action during a trade.
 *
 * Fetches candles through /api/candles (which reads from the server-wide
 * CandleCache — no extra API calls for trades whose MFE/MAE has already
 * been computed). Timeframe auto-selects from hold duration; user can
 * override. Context candles before entry render dimmer; active candles
 * during the trade stream in on play.
 *
 * Entry / exit / MFE / MAE are drawn as horizontal price lines on the
 * chart. Entry and exit only appear once the playhead reaches their
 * timestamps; MFE and MAE appear once the playhead reaches the candle that
 * actually contains the extreme (not the timestamp — price lines are about
 * WHERE the excursion happened, not when the metric was computed).
 *
 * Running P&L below the chart recomputes each candle advance, using the
 * current candle's close as the mark price and the position's entry price
 * and size. It's unrealized — what the trade would have shown if closed
 * at that bar.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type {
  IChartApi,
  ISeriesApi,
  IPriceLine,
  CandlestickData,
  UTCTimestamp,
} from 'lightweight-charts';
import { useAuthFetch } from '@/lib/api-client';

// lightweight-charts is browser-only — it touches `document` at module
// evaluation time and throws during Next's SSR bundling if imported at the
// top level. Loading it via dynamic `import()` inside a client-only effect
// keeps the module out of the server chunk entirely. Types are still pulled
// in via `import type` above (erased at compile time, safe on the server).
type LightweightChartsModule = typeof import('lightweight-charts');

// ── Types ──────────────────────────────────────────────────────────────────

interface ReplayPosition {
  id: string;
  asset: string;
  direction: string;
  averageEntryPrice: number | null;
  averageExitPrice: number | null;
  totalSize: number | null;
  aggregatePnl: number | null;
  firstEntryTime: string | null;
  lastExitTime: string | null;
  mfePrice?: number | null;
  maePrice?: number | null;
  exitEfficiency: number | null;
  holdTimeSeconds: number | null;
}

interface RawCandle {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h';

const TIMEFRAME_MS: Record<Timeframe, number> = {
  '1m':  60_000,
  '5m':  300_000,
  '15m': 900_000,
  '1h':  3_600_000,
  '4h':  14_400_000,
};

const TIMEFRAME_LABELS: Array<{ value: Timeframe; label: string }> = [
  { value: '1m',  label: '1m'  },
  { value: '5m',  label: '5m'  },
  { value: '15m', label: '15m' },
  { value: '1h',  label: '1h'  },
  { value: '4h',  label: '4h'  },
];

const SPEEDS = [1, 2, 5, 10] as const;
type Speed = typeof SPEEDS[number];

const CONTEXT_CANDLES = 20;
const BASE_TICK_MS = 500;

// Colors (dark theme per spec)
const UP_COLOR   = '#22c55e';
const DOWN_COLOR = '#ef4444';
const CONTEXT_UP_COLOR   = 'rgba(34, 197, 94, 0.35)';
const CONTEXT_DOWN_COLOR = 'rgba(239, 68, 68, 0.35)';
const GRID_COLOR = '#1e293b';
const TEXT_COLOR = '#94a3b8';
const CROSSHAIR_COLOR = '#64748b';

// ── Helpers ────────────────────────────────────────────────────────────────

function pickTimeframe(holdSeconds: number | null): Timeframe {
  if (holdSeconds == null) return '15m';
  if (holdSeconds < 3600) return '1m';
  if (holdSeconds < 8 * 3600) return '5m';
  if (holdSeconds < 48 * 3600) return '15m';
  if (holdSeconds < 14 * 86400) return '1h';
  return '4h';
}

function fmtPrice(v: number | null | undefined): string {
  if (v == null) return '—';
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}

function fmtPnl(v: number): string {
  return `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
}

function fmtDuration(seconds: number | null): string {
  if (seconds == null) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

function unrealizedPnl(
  entryPrice: number | null,
  size: number | null,
  direction: string,
  markPrice: number,
): number {
  if (entryPrice == null || size == null) return 0;
  return direction === 'long'
    ? (markPrice - entryPrice) * size
    : (entryPrice - markPrice) * size;
}

// ── Component ──────────────────────────────────────────────────────────────

export default function TradeReplay({ position }: { position: ReplayPosition }) {
  const authFetch = useAuthFetch();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const priceLinesRef = useRef<Record<string, IPriceLine>>({});
  const lcRef = useRef<LightweightChartsModule | null>(null);
  const [lcReady, setLcReady] = useState(false);

  const [rawCandles, setRawCandles] = useState<RawCandle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [timeframe, setTimeframe] = useState<Timeframe>(() => pickTimeframe(position.holdTimeSeconds));
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);

  // currentIndex = number of ACTIVE candles revealed (entry candle counts as 1).
  // Context candles (before entry) are always visible.
  const [currentIndex, setCurrentIndex] = useState(1);
  const [contextCount, setContextCount] = useState(0);

  const entryTime = position.firstEntryTime ? new Date(position.firstEntryTime).getTime() : null;
  const exitTime  = position.lastExitTime   ? new Date(position.lastExitTime).getTime()   : null;

  // ── Fetch candles ────────────────────────────────────────────────────────

  useEffect(() => {
    if (entryTime == null) {
      setError('Trade has no entry time — replay not available.');
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    const intervalMs = TIMEFRAME_MS[timeframe];
    const fetchStart = entryTime - CONTEXT_CANDLES * intervalMs;
    // For closed positions, fetch up to exit; for open positions, fetch up to now.
    const fetchEnd = exitTime ?? Date.now();
    // Clamp to avoid requesting future candles
    const effectiveEnd = Math.min(fetchEnd, Date.now());

    const url = `/api/candles?asset=${encodeURIComponent(position.asset)}` +
      `&timeframe=${timeframe}` +
      `&start=${encodeURIComponent(new Date(fetchStart).toISOString())}` +
      `&end=${encodeURIComponent(new Date(effectiveEnd).toISOString())}`;

    authFetch(url, { signal: controller.signal })
      .then((r) => r.json())
      .then((data: { candles?: RawCandle[]; error?: string }) => {
        if (data.error) {
          setError(data.error);
          setRawCandles([]);
          return;
        }
        const candles = data.candles ?? [];
        if (candles.length === 0) {
          setError(`Replay not available — no price data for ${position.asset}.`);
        }
        setRawCandles(candles);
        // Reset playback to the entry candle
        const ctx = candles.filter((c) => new Date(c.timestamp).getTime() < entryTime).length;
        setContextCount(ctx);
        setCurrentIndex(1);
        setPlaying(false);
      })
      .catch((err) => {
        if (err?.name !== 'AbortError') {
          setError(`Failed to load candles: ${err.message}`);
        }
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [position.asset, timeframe, entryTime, exitTime, authFetch]);

  const totalActive = Math.max(0, rawCandles.length - contextCount);

  // ── Dynamic lightweight-charts load ──────────────────────────────────────
  //
  // Runs once on mount. After the module lands, `lcReady` flips true and
  // the chart-init effect below picks it up. Strictly client-only — inside
  // useEffect, so the dynamic import is never evaluated during SSR.

  useEffect(() => {
    let cancelled = false;
    import('lightweight-charts').then((mod) => {
      if (cancelled) return;
      lcRef.current = mod;
      setLcReady(true);
    });
    return () => { cancelled = true; };
  }, []);

  // ── Chart init ───────────────────────────────────────────────────────────

  const hasCandles = rawCandles.length > 0;

  useEffect(() => {
    if (!lcReady || !lcRef.current || !containerRef.current || !hasCandles) return;
    const { createChart, CandlestickSeries } = lcRef.current;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: 'transparent' },
        textColor: TEXT_COLOR,
      },
      grid: {
        vertLines: { color: GRID_COLOR },
        horzLines: { color: GRID_COLOR },
      },
      crosshair: {
        mode: 1,
        vertLine: { color: CROSSHAIR_COLOR, width: 1 },
        horzLine: { color: CROSSHAIR_COLOR, width: 1 },
      },
      timeScale: {
        borderColor: GRID_COLOR,
        timeVisible: true,
        secondsVisible: timeframe === '1m',
      },
      rightPriceScale: {
        borderColor: GRID_COLOR,
      },
      autoSize: true,
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR,
      downColor: DOWN_COLOR,
      borderUpColor: UP_COLOR,
      borderDownColor: DOWN_COLOR,
      wickUpColor: UP_COLOR,
      wickDownColor: DOWN_COLOR,
    });

    chartRef.current = chart;
    seriesRef.current = series;

    return () => {
      priceLinesRef.current = {};
      seriesRef.current = null;
      chartRef.current = null;
      chart.remove();
    };
  }, [lcReady, hasCandles, timeframe]);

  // ── Candlestick data + per-bar dimming for context ───────────────────────

  const displayedCandles: CandlestickData[] = useMemo(() => {
    if (rawCandles.length === 0) return [];
    const cutoff = contextCount + currentIndex;
    const slice = rawCandles.slice(0, cutoff);
    return slice.map((c, i) => {
      const ts = Math.floor(new Date(c.timestamp).getTime() / 1000) as UTCTimestamp;
      const isContext = i < contextCount;
      const isUp = c.close >= c.open;
      const colorUp   = isContext ? CONTEXT_UP_COLOR   : UP_COLOR;
      const colorDown = isContext ? CONTEXT_DOWN_COLOR : DOWN_COLOR;
      return {
        time: ts,
        open:  c.open,
        high:  c.high,
        low:   c.low,
        close: c.close,
        color:       isUp ? colorUp   : colorDown,
        borderColor: isUp ? colorUp   : colorDown,
        wickColor:   isUp ? colorUp   : colorDown,
      };
    });
  }, [rawCandles, contextCount, currentIndex]);

  // Push data to the series whenever the slice changes
  useEffect(() => {
    if (!seriesRef.current) return;
    seriesRef.current.setData(displayedCandles);
  }, [displayedCandles]);

  // ── Price lines: entry / exit / MFE / MAE ────────────────────────────────
  //
  // Added to the chart as soon as the playhead reaches the relevant candle.
  // Removed if the user rewinds past that point.

  useEffect(() => {
    const series = seriesRef.current;
    const lc = lcRef.current;
    if (!series || !lc || rawCandles.length === 0) return;
    const { LineStyle } = lc;

    const shown = displayedCandles.length;
    if (shown === 0) return;

    const latestCandle = rawCandles[shown - 1];
    const latestMs = new Date(latestCandle.timestamp).getTime();

    const ensureLine = (
      key: string,
      shouldShow: boolean,
      options: { price: number; color: string; lineStyle: number; title: string },
    ) => {
      const existing = priceLinesRef.current[key];
      if (shouldShow && !existing) {
        priceLinesRef.current[key] = series.createPriceLine({
          price: options.price,
          color: options.color,
          lineWidth: 1,
          lineStyle: options.lineStyle,
          axisLabelVisible: true,
          title: options.title,
        });
      } else if (!shouldShow && existing) {
        series.removePriceLine(existing);
        delete priceLinesRef.current[key];
      }
    };

    // Entry — shown once playhead reaches the entry bar.
    if (entryTime != null && position.averageEntryPrice != null) {
      ensureLine('entry', latestMs >= entryTime, {
        price: position.averageEntryPrice,
        color: position.direction === 'long' ? UP_COLOR : DOWN_COLOR,
        lineStyle: LineStyle.Solid,
        title: `Entry ${fmtPrice(position.averageEntryPrice)}`,
      });
    }

    // Exit — shown once playhead reaches the exit bar. Closed longs exit by
    // selling (red-ish label), closed shorts exit by buying back (green-ish).
    if (exitTime != null && position.averageExitPrice != null) {
      ensureLine('exit', latestMs >= exitTime, {
        price: position.averageExitPrice,
        color: position.direction === 'long' ? DOWN_COLOR : UP_COLOR,
        lineStyle: LineStyle.Solid,
        title: `Exit ${fmtPrice(position.averageExitPrice)}`,
      });
    }

    // MFE / MAE — appear when the candle that contains the extreme has been
    // revealed. We scan the revealed slice for the first bar whose range
    // crosses the extreme price.
    const firstBarContaining = (price: number): RawCandle | null => {
      for (let i = 0; i < shown; i++) {
        const c = rawCandles[i];
        if (c.low <= price && c.high >= price) return c;
      }
      return null;
    };

    if (position.mfePrice != null) {
      ensureLine('mfe', firstBarContaining(position.mfePrice) != null, {
        price: position.mfePrice,
        color: UP_COLOR,
        lineStyle: LineStyle.Dashed,
        title: `MFE ${fmtPrice(position.mfePrice)}`,
      });
    }

    if (position.maePrice != null) {
      ensureLine('mae', firstBarContaining(position.maePrice) != null, {
        price: position.maePrice,
        color: DOWN_COLOR,
        lineStyle: LineStyle.Dashed,
        title: `MAE ${fmtPrice(position.maePrice)}`,
      });
    }
  }, [displayedCandles, rawCandles, entryTime, exitTime, position]);

  // ── Playback loop ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!playing) return;
    if (currentIndex >= totalActive) {
      setPlaying(false);
      return;
    }
    const tickMs = BASE_TICK_MS / speed;
    const id = setTimeout(() => {
      setCurrentIndex((i) => Math.min(totalActive, i + 1));
    }, tickMs);
    return () => clearTimeout(id);
  }, [playing, speed, currentIndex, totalActive]);

  // Reset the in-flight chart playback when timeframe / candles change (the
  // fetch effect also resets, but this catches client-side timeframe flips
  // between already-cached ranges instantly).
  useEffect(() => {
    setPlaying(false);
  }, [timeframe]);

  // ── Running P&L ──────────────────────────────────────────────────────────

  const runningPnl = useMemo(() => {
    if (displayedCandles.length === 0 || position.averageEntryPrice == null || position.totalSize == null) return null;
    const markBar = displayedCandles[displayedCandles.length - 1];
    return unrealizedPnl(position.averageEntryPrice, position.totalSize, position.direction, markBar.close);
  }, [displayedCandles, position]);

  // ── Controls ─────────────────────────────────────────────────────────────

  const handlePlayPause = useCallback(() => {
    if (totalActive === 0) return;
    if (currentIndex >= totalActive) {
      setCurrentIndex(1);
      setPlaying(true);
      return;
    }
    setPlaying((p) => !p);
  }, [currentIndex, totalActive]);

  const handleSkipStart = useCallback(() => {
    setPlaying(false);
    setCurrentIndex(1);
  }, []);

  const handleSkipEnd = useCallback(() => {
    setPlaying(false);
    setCurrentIndex(totalActive);
  }, [totalActive]);

  const progress = totalActive > 0 ? currentIndex / totalActive : 0;

  // ── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="h-[350px] flex items-center justify-center text-sm text-[#6e7681]">
        Loading price data...
      </div>
    );
  }

  if (error || rawCandles.length === 0) {
    return (
      <div className="h-[350px] flex items-center justify-center text-sm text-[#6e7681] text-center px-4">
        {error ?? `Replay not available — no price data for ${position.asset}.`}
      </div>
    );
  }

  const captured = position.exitEfficiency != null
    ? `${(position.exitEfficiency * 100).toFixed(1)}%`
    : '—';

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <div className="flex items-center gap-1">
          <button
            onClick={handleSkipStart}
            className="px-2 py-1 rounded border border-[#30363d] bg-[#21262d] text-[#8b949e] hover:text-white hover:border-[#484f58]"
            aria-label="Skip to start"
          >
            ⏮
          </button>
          <button
            onClick={handlePlayPause}
            className="px-3 py-1 rounded border border-[#30363d] bg-[#21262d] text-[#e6edf3] hover:border-[#484f58] min-w-[58px]"
          >
            {playing ? '⏸ Pause' : currentIndex >= totalActive ? '↻ Replay' : '▶ Play'}
          </button>
          <button
            onClick={handleSkipEnd}
            className="px-2 py-1 rounded border border-[#30363d] bg-[#21262d] text-[#8b949e] hover:text-white hover:border-[#484f58]"
            aria-label="Skip to end"
          >
            ⏭
          </button>
        </div>

        {/* Speed */}
        <div className="flex items-center gap-1">
          <span className="text-[10px] uppercase tracking-widest text-[#6e7681]">Speed</span>
          {SPEEDS.map((s) => (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              className={`px-2 py-1 rounded border text-[11px] ${
                s === speed
                  ? 'border-blue-500/50 bg-blue-900/30 text-blue-300'
                  : 'border-[#30363d] bg-[#21262d] text-[#8b949e] hover:text-white'
              }`}
            >
              {s}x
            </button>
          ))}
        </div>

        {/* Timeframe */}
        <div className="flex items-center gap-1 ml-auto">
          <span className="text-[10px] uppercase tracking-widest text-[#6e7681]">TF</span>
          {TIMEFRAME_LABELS.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => setTimeframe(value)}
              className={`px-2 py-1 rounded border text-[11px] ${
                value === timeframe
                  ? 'border-blue-500/50 bg-blue-900/30 text-blue-300'
                  : 'border-[#30363d] bg-[#21262d] text-[#8b949e] hover:text-white'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-1 w-full bg-[#161b22] rounded overflow-hidden">
        <div
          className="h-full bg-blue-500/60 transition-all duration-100"
          style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }}
        />
      </div>

      {/* Chart */}
      <div
        ref={containerRef}
        className="w-full rounded border border-[#21262d] bg-[#0f1729]"
        style={{ height: 350 }}
      />

      {/* Running P&L */}
      <div className="flex items-baseline gap-4">
        <span className="text-[10px] uppercase tracking-widest text-[#6e7681]">Running P&amp;L</span>
        <span className={`text-xl font-bold tabular-nums ${
          runningPnl == null ? 'text-[#6e7681]' : runningPnl >= 0 ? 'text-green-400' : 'text-red-400'
        }`}>
          {runningPnl == null ? '—' : fmtPnl(runningPnl)}
        </span>
        <span className="text-[11px] text-[#6e7681] ml-auto">
          {currentIndex} / {totalActive} bars
        </span>
      </div>

      {/* Stats line */}
      <div className="text-xs text-[#8b949e] flex flex-wrap gap-x-4 gap-y-1 border-t border-[#21262d] pt-3">
        <span>Duration: <span className="text-[#e6edf3]">{fmtDuration(position.holdTimeSeconds)}</span></span>
        <span>Entry: <span className="text-[#e6edf3]">{fmtPrice(position.averageEntryPrice)}</span></span>
        <span>Exit: <span className="text-[#e6edf3]">{fmtPrice(position.averageExitPrice)}</span></span>
        <span>MFE: <span className="text-green-400">{fmtPrice(position.mfePrice)}</span></span>
        <span>MAE: <span className="text-red-400">{fmtPrice(position.maePrice)}</span></span>
        <span>Captured: <span className="text-[#e6edf3]">{captured}</span></span>
      </div>
    </div>
  );
}
