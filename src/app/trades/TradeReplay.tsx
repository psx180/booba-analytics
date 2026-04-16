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
 * Entry, MFE, and MAE are drawn as static horizontal price lines created
 * once when the chart mounts — they sit at their fixed prices and never
 * move during playback (autoscaling changes pixel position, not price).
 * Exit is the only dynamic line: it appears labeled once the playhead
 * reaches the exit candle, and disappears if the user rewinds past it.
 * BUY/SELL markers are added progressively — after each tick the visible
 * set is recomputed and only fills whose candle bar has been revealed are
 * shown. For scaled positions with multiple entries/exits, one arrow per
 * fill appears at its actual fill timestamp as playback passes it.
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
  ISeriesMarkersPluginApi,
  SeriesMarker,
  CandlestickData,
  UTCTimestamp,
  Time,
} from 'lightweight-charts';
import { useAuthFetch } from '@/lib/api-client';

// lightweight-charts is browser-only — it touches `document` at module
// evaluation time and throws during Next's SSR bundling if imported at the
// top level. Loading it via dynamic `import()` inside a client-only effect
// keeps the module out of the server chunk entirely. Types are still pulled
// in via `import type` above (erased at compile time, safe on the server).
type LightweightChartsModule = typeof import('lightweight-charts');

// ── Types ──────────────────────────────────────────────────────────────────

interface FillMarker {
  time: string;   // ISO timestamp of the fill
  price: number;  // fill price (used for future reference; markers anchor to candle bar)
}

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
  // Per-fill timestamps for scaled positions (optional; falls back to firstEntryTime/lastExitTime)
  entryFills?: FillMarker[];
  exitFills?: FillMarker[];
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
  const markersPluginRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
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
    // Clear the old timeframe's candles up front — this toggles `hasCandles`
    // false for a render, which runs the chart-init cleanup and destroys the
    // old chart. When the new fetch lands, the chart re-mounts from scratch.
    setRawCandles([]);

    const intervalMs = TIMEFRAME_MS[timeframe];
    // Request one extra candle-width on each side so the boundary-aligned
    // entry candle (whose open time is floor(entryTime / intervalMs)) always
    // comes back, plus a full 20 context candles before it.
    const fetchStart = entryTime - (CONTEXT_CANDLES + 1) * intervalMs;
    // For closed positions, fetch up to exit; for open positions, fetch up to now.
    const fetchEnd = exitTime ?? Date.now();
    // Clamp to avoid requesting future candles
    const effectiveEnd = Math.min(fetchEnd + intervalMs, Date.now());

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
        // Entry candle = last candle whose open-time is at or before entryTime.
        // Context = every candle STRICTLY BEFORE that one. Without `<=` the
        // boundary-aligned entry candle itself would land in the context set
        // and the first "active" reveal would skip the entry bar.
        let entryIdx = -1;
        for (let i = 0; i < candles.length; i++) {
          if (new Date(candles[i].timestamp).getTime() <= entryTime) entryIdx = i;
          else break;
        }
        setContextCount(entryIdx >= 0 ? entryIdx : 0);
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
  //
  // Runs whenever lightweight-charts finishes loading, whenever the user
  // switches timeframe (the fetch effect blanks rawCandles first, which
  // flips hasCandles false and fires the cleanup below), or whenever fresh
  // data lands for a new timeframe. The chart is fully destroyed and
  // recreated on every such transition so we never mutate an existing chart
  // with data from a different scale.
  //
  // Static price lines for entry / MFE / MAE are created inside this effect
  // so they exist from the moment the chart mounts and never shift during
  // playback. (The exit price line is dynamic and lives in its own effect
  // below — it appears only when the playhead reaches the exit candle.)
  // Entry / exit markers (BUY/SELL arrows) are also attached here once:
  // lightweight-charts only renders a marker when its `time` is present in
  // the series data, so we can add both up front and they surface naturally
  // as the playback reveals their candles.

  const hasCandles = rawCandles.length > 0;

  useEffect(() => {
    if (!lcReady || !lcRef.current || !containerRef.current || !hasCandles) return;
    const { createChart, CandlestickSeries, createSeriesMarkers, LineStyle } = lcRef.current;

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
      // Kill the built-in last-price line — that's the unlabeled red/green
      // line that follows the most recent candle's close. We draw our own
      // labeled entry/exit/MFE/MAE lines and don't want the auto one to
      // compete visually.
      priceLineVisible: false,
      lastValueVisible: false,
    });

    chartRef.current = chart;
    seriesRef.current = series;

    // ── Static price lines (entry / MFE / MAE) ────────────────────────────
    //
    // Created once at mount; never touched during playback. The lines hold
    // a fixed price, so when autoscaling expands the Y axis later the lines
    // stay put in price space and only their pixel position shifts — which
    // the user reads as "static lines on a moving chart", the intended feel.

    if (entryTime != null && position.averageEntryPrice != null) {
      priceLinesRef.current.entry = series.createPriceLine({
        price: position.averageEntryPrice,
        color: position.direction === 'long' ? UP_COLOR : DOWN_COLOR,
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: `Entry ${fmtPrice(position.averageEntryPrice)}`,
      });
    }
    if (position.mfePrice != null) {
      priceLinesRef.current.mfe = series.createPriceLine({
        price: position.mfePrice,
        color: UP_COLOR,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: `MFE ${fmtPrice(position.mfePrice)}`,
      });
    }
    if (position.maePrice != null) {
      priceLinesRef.current.mae = series.createPriceLine({
        price: position.maePrice,
        color: DOWN_COLOR,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: `MAE ${fmtPrice(position.maePrice)}`,
      });
    }

    // ── Entry / exit markers ──────────────────────────────────────────────
    //
    // Create the plugin with an empty set — markers are added progressively
    // in the data-update effect below as playback reveals each fill's candle.

    markersPluginRef.current = createSeriesMarkers(series, []);

    return () => {
      markersPluginRef.current?.detach();
      markersPluginRef.current = null;
      priceLinesRef.current = {};
      seriesRef.current = null;
      chartRef.current = null;
      chart.remove();
    };
  }, [lcReady, hasCandles, timeframe, entryTime, position.averageEntryPrice, position.mfePrice, position.maePrice, position.direction]);

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

  // Push data to the series whenever the slice changes.
  //
  // Bug 1 fix: use setVisibleLogicalRange instead of fitContent so the chart
  // holds a fixed ~35-candle viewport that scrolls as playback advances — the
  // oldest candle falls off the left, the newest enters from the right.
  //
  // Bug 2 & 3 fix: recompute markers after each tick, only including those
  // whose candle bar has already been revealed (fillTs ≤ latest displayed ts).
  // This ensures BUY/SELL arrows appear at their actual fill timestamps and
  // are added progressively rather than all at once (which caused the SELL
  // marker to be shown on the wrong candle before the exit was reached).
  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart || displayedCandles.length === 0) return;

    series.setData(displayedCandles);

    // Fixed scrolling viewport (Bug 1)
    const VIEWPORT = 35;
    const HEADROOM = 5;
    const to   = displayedCandles.length - 1 + HEADROOM;
    const from = Math.max(0, to - VIEWPORT);
    chart.timeScale().setVisibleLogicalRange({ from, to });

    // Progressive markers (Bugs 2 & 3)
    const plugin = markersPluginRef.current;
    if (!plugin) return;

    const latestTs = displayedCandles[displayedCandles.length - 1].time as number; // UTCTimestamp (seconds)
    const isLong = position.direction === 'long';

    // Map a fill's epoch-ms to the UTCTimestamp of its containing candle bar.
    const findCandleTs = (targetMs: number): UTCTimestamp | null => {
      let result: UTCTimestamp | null = null;
      for (const c of rawCandles) {
        if (new Date(c.timestamp).getTime() <= targetMs) {
          result = Math.floor(new Date(c.timestamp).getTime() / 1000) as UTCTimestamp;
        } else break;
      }
      return result;
    };

    // Use per-fill arrays if provided; fall back to single averaged entry/exit.
    const eFills: FillMarker[] =
      position.entryFills && position.entryFills.length > 0
        ? position.entryFills
        : entryTime != null && position.averageEntryPrice != null && position.firstEntryTime
          ? [{ time: position.firstEntryTime, price: position.averageEntryPrice }]
          : [];

    const xFills: FillMarker[] =
      position.exitFills && position.exitFills.length > 0
        ? position.exitFills
        : exitTime != null && position.averageExitPrice != null && position.lastExitTime
          ? [{ time: position.lastExitTime, price: position.averageExitPrice }]
          : [];

    const markers: SeriesMarker<Time>[] = [];

    for (const fill of eFills) {
      const ts = findCandleTs(new Date(fill.time).getTime());
      if (ts == null || ts > latestTs) continue;
      markers.push({
        time: ts,
        position: isLong ? 'belowBar' : 'aboveBar',
        shape:    isLong ? 'arrowUp'  : 'arrowDown',
        color:    isLong ? UP_COLOR   : DOWN_COLOR,
        text:     isLong ? 'BUY'      : 'SELL',
      });
    }

    for (const fill of xFills) {
      const ts = findCandleTs(new Date(fill.time).getTime());
      if (ts == null || ts > latestTs) continue;
      markers.push({
        time: ts,
        position: isLong ? 'aboveBar' : 'belowBar',
        shape:    isLong ? 'arrowDown' : 'arrowUp',
        color:    isLong ? DOWN_COLOR  : UP_COLOR,
        text:     isLong ? 'SELL'      : 'BUY',
      });
    }

    // lightweight-charts requires markers sorted by time
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    plugin.setMarkers(markers);
  }, [displayedCandles, rawCandles, position, entryTime, exitTime]);

  // ── Dynamic exit price line ──────────────────────────────────────────────
  //
  // The only line that isn't static. Appears labeled 'Exit $X' once the
  // playhead reaches the exit candle; removed again if the user rewinds
  // before it. Everything else (entry / MFE / MAE) lives on the static side
  // in the chart-init effect.

  useEffect(() => {
    const series = seriesRef.current;
    const lc = lcRef.current;
    if (!series || !lc) return;
    if (exitTime == null || position.averageExitPrice == null) return;

    const shown = displayedCandles.length;
    if (shown === 0) return;

    const latestMs = new Date(rawCandles[shown - 1].timestamp).getTime();
    const shouldShow = latestMs >= exitTime;
    const existing = priceLinesRef.current.exit;

    if (shouldShow && !existing) {
      priceLinesRef.current.exit = series.createPriceLine({
        price: position.averageExitPrice,
        color: position.direction === 'long' ? DOWN_COLOR : UP_COLOR,
        lineWidth: 1,
        lineStyle: lc.LineStyle.Solid,
        axisLabelVisible: true,
        title: `Exit ${fmtPrice(position.averageExitPrice)}`,
      });
    } else if (!shouldShow && existing) {
      series.removePriceLine(existing);
      delete priceLinesRef.current.exit;
    }
  }, [displayedCandles, rawCandles, exitTime, position.averageExitPrice, position.direction]);

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
