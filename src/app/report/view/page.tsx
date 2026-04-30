/**
 * /report/view?wallet=ADDRESS — server-rendered, browser-viewable report.
 *
 * Replaces the pdfkit PDF for the primary read path. The user views the
 * report in the browser and prints to PDF via the sticky-header button
 * (Ctrl+P fires the same path). The pdf-renderer.ts file is kept around as
 * the fallback for /api/report?format=pdf so external integrations keep
 * working.
 *
 * The page is a server component: it calls generateReport() directly and
 * passes the resulting TradingReport down to the JSX. Action buttons
 * (Print / Download JSON / View Full App / Generate Another) live in a
 * sibling 'use client' component because they need onClick + cookie
 * mutation + router access.
 */

import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { generateReport } from '@/services/report/report-service';
import type {
  BehavioralSection,
  BreakdownRow,
  ExecutionSection,
  ExecutiveSummarySection,
  MethodologyConfidence,
  MethodologyEntry,
  MethodologySection,
  PerformanceSection,
  RegimeSection,
  RiskSection,
  TradingReport,
} from '@/services/report/types';
import ReportActions from './ReportActions';

// Public page: no auth required, mirrors /report behavior.
export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ wallet?: string }>;
}

export default async function ReportViewPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const wallet = (params?.wallet ?? '').trim();

  if (!wallet || !/^[A-Za-z0-9]{32,88}$/.test(wallet)) {
    return <Shell><InvalidWalletMessage /></Shell>;
  }

  // Bail early if we have no positions for this wallet — generateReport
  // would still run, but there's nothing to show and the user is better
  // routed to the import page.
  const positionCount = await prisma.position.count({ where: { walletAddress: wallet } });
  if (positionCount === 0) {
    return <Shell><NotImportedMessage wallet={wallet} /></Shell>;
  }

  const report = await generateReport(wallet);

  return (
    <div className="min-h-screen bg-[#0d1117] text-[#c9d1d9] print:bg-white print:text-black">
      <PrintStyles />
      <ReportActions wallet={wallet} reportJson={JSON.stringify(report, null, 2)} />
      <main className="max-w-5xl mx-auto px-6 py-10 print:max-w-none print:px-0 print:py-0 print:mx-0">
        <CoverSection report={report} />
        {report.sections.executiveSummary && (
          <ExecutiveSummary section={report.sections.executiveSummary} />
        )}
        {report.sections.performance && <Performance section={report.sections.performance} />}
        {report.sections.behavioral && <Behavioral section={report.sections.behavioral} />}
        {report.sections.risk && <Risk section={report.sections.risk} />}
        {report.sections.execution && <Execution section={report.sections.execution} />}
        {report.sections.regime && <Regime section={report.sections.regime} />}
        <Methodology section={report.sections.methodology} />
      </main>
    </div>
  );
}

// ─── Shell + empty states ──────────────────────────────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#0d1117] text-[#c9d1d9] flex items-center justify-center px-6 py-12">
      <div className="max-w-md w-full text-center">{children}</div>
    </div>
  );
}

function InvalidWalletMessage() {
  return (
    <>
      <h1 className="text-2xl font-semibold text-white mb-2">No wallet specified</h1>
      <p className="text-sm text-[#8b949e] mb-8">
        Provide a wallet via <span className="font-mono">?wallet=ADDRESS</span> in the URL,
        or generate a report from scratch.
      </p>
      <Link
        href="/connect"
        className="inline-block px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium"
      >
        Generate a report
      </Link>
    </>
  );
}

function NotImportedMessage({ wallet }: { wallet: string }) {
  return (
    <>
      <h1 className="text-2xl font-semibold text-white mb-2">Wallet not yet analyzed</h1>
      <p className="text-sm text-[#8b949e] mb-1">
        We have no imported positions for
      </p>
      <p className="font-mono text-xs text-[#c9d1d9] mb-8 break-all">{wallet}</p>
      <Link
        href={`/report?wallet=${encodeURIComponent(wallet)}`}
        className="inline-block px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium"
      >
        Generate a report first
      </Link>
    </>
  );
}

// ─── Cover ─────────────────────────────────────────────────────────────────

function CoverSection({ report }: { report: TradingReport }) {
  const cs = report.sections.executiveSummary?.compositeScore;
  return (
    <section className="pt-8 pb-12 border-b border-[#30363d] print:border-b-2 print:border-black/40">
      <div className="text-[11px] font-semibold tracking-[0.3em] uppercase text-[#58a6ff] print:text-blue-700 mb-4">
        BOOBAnalytics
      </div>
      <h1 className="text-5xl font-bold text-white print:text-black tracking-tight mb-6">
        Trading Report
      </h1>

      <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3 text-sm mb-8">
        <CoverRow label="Wallet" value={<span className="font-mono">{truncateWallet(report.walletAddress)}</span>} />
        <CoverRow label="Generated" value={fmtDateLong(report.generatedAt)} />
        <CoverRow
          label="Period"
          value={`${fmtDate(report.period.from)} → ${fmtDate(report.period.to)}`}
        />
        <CoverRow label="Trades" value={report.tradeCount.toLocaleString()} />
        <CoverRow
          label="Filters"
          value={report.filtersDescription || 'Full trading history'}
          full
        />
      </dl>

      {cs && (
        <div className="mt-6 p-6 rounded-xl border border-[#30363d] bg-[#161b22] print:bg-white print:border-black/20">
          <div className="text-[11px] font-semibold tracking-[0.25em] uppercase text-[#8b949e] print:text-gray-600 mb-2">
            Composite Trader Score
          </div>
          <div className="flex items-baseline gap-4">
            <div className={`text-7xl font-bold ${tierColorClass(cs.tier)} print:text-black tabular-nums`}>
              {cs.score.toFixed(1)}
            </div>
            <div className="text-lg text-[#c9d1d9] print:text-black">{cs.tier}</div>
          </div>
          <p className="mt-3 text-xs text-[#8b949e] print:text-gray-600 italic">
            Inspired by baseball&apos;s Wins Above Replacement — aggregates entry, exit, risk,
            timing, and decision-consistency axes into a single number. See methodology.
          </p>
        </div>
      )}
    </section>
  );
}

function CoverRow({ label, value, full }: { label: string; value: React.ReactNode; full?: boolean }) {
  return (
    <div className={full ? 'md:col-span-2' : ''}>
      <dt className="text-[11px] uppercase tracking-wider text-[#6e7681] print:text-gray-500 mb-0.5">
        {label}
      </dt>
      <dd className="text-[#c9d1d9] print:text-black">{value}</dd>
    </div>
  );
}

// ─── Section primitives ────────────────────────────────────────────────────

function SectionHeader({ kicker, title }: { kicker: string; title: string }) {
  return (
    <header className="mb-6 mt-2">
      <div className="text-[11px] font-semibold tracking-[0.3em] uppercase text-[#58a6ff] print:text-blue-700 mb-2">
        {kicker}
      </div>
      <h2 className="text-3xl font-bold text-white print:text-black tracking-tight">
        {title}
      </h2>
      <div className="mt-3 h-px bg-gradient-to-r from-[#30363d] via-[#30363d] to-transparent print:bg-black/30" />
    </header>
  );
}

function Section({
  kicker,
  title,
  summary,
  children,
}: {
  kicker: string;
  title: string;
  summary?: string | null;
  children: React.ReactNode;
}) {
  return (
    <section className="page-break pt-12 pb-10 print:pt-8 print:pb-6">
      <SectionHeader kicker={kicker} title={title} />
      {summary && (
        <p className="italic text-[#8b949e] print:text-gray-700 text-base leading-relaxed mb-6 max-w-3xl">
          {summary}
        </p>
      )}
      {children}
    </section>
  );
}

function Subheader({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-sm font-semibold tracking-wide uppercase text-[#c9d1d9] print:text-black mt-8 mb-3">
      {children}
    </h3>
  );
}

// ─── Executive summary ─────────────────────────────────────────────────────

function ExecutiveSummary({ section }: { section: ExecutiveSummarySection }) {
  const m = section.headlineMetrics;
  const cells: MetricCell[] = [
    { label: 'Sharpe', value: fmtNum(m.sharpe, 2), sign: signFromValue(m.sharpe), interp: interpSharpe(m.sharpe) },
    { label: 'Sortino', value: fmtNum(m.sortino, 2), sign: signFromValue(m.sortino), interp: interpSortino(m.sortino) },
    { label: 'Calmar', value: fmtNum(m.calmar, 2), sign: signFromValue(m.calmar), interp: interpCalmar(m.calmar) },
    { label: 'Win rate', value: fmtPct(m.winRate), sign: 'neutral', interp: interpWinRate(m.winRate) },
    { label: 'Expectancy', value: fmtMoney(m.expectancy), sign: signFromValue(m.expectancy), interp: interpExpectancy(m.expectancy) },
    { label: 'Profit factor', value: fmtNum(m.profitFactor, 2), sign: m.profitFactor >= 1 ? 'pos' : 'neg', interp: interpProfitFactor(m.profitFactor) },
  ];

  return (
    <Section kicker="01" title="Executive Summary">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {cells.map((c) => <MetricCard key={c.label} cell={c} />)}
      </div>

      <p className="mt-4 text-xs text-[#6e7681] print:text-gray-600 italic">
        Sharpe / Sortino / Calmar express return per unit of risk; values above 1 are strong,
        below 0 indicate negative risk-adjusted returns.
      </p>

      {section.compositeScore.axes && Object.keys(section.compositeScore.axes).length > 0 && (
        <>
          <Subheader>Composite score axes</Subheader>
          <KvList rows={Object.entries(section.compositeScore.axes).map(([k, v]) => ({
            label: wartAxisLabel(k),
            value: fmtNum(v, 1),
          }))} />
        </>
      )}

      {section.topStrengths.length > 0 && (
        <>
          <Subheader>Top strengths</Subheader>
          <BulletList items={section.topStrengths} variant="green" />
        </>
      )}
      {section.topWeaknesses.length > 0 && (
        <>
          <Subheader>Top weaknesses</Subheader>
          <BulletList items={section.topWeaknesses} variant="red" />
        </>
      )}
      {section.recommendations.length > 0 && (
        <>
          <Subheader>Recommendations</Subheader>
          <BulletList items={section.recommendations} variant="blue" />
        </>
      )}

      <p className="mt-6 text-xs text-[#6e7681] print:text-gray-600 italic">
        Interpretations are approximate benchmarks, not definitive assessments.
      </p>
    </Section>
  );
}

interface MetricCell {
  label: string;
  value: string;
  sign: 'pos' | 'neg' | 'neutral';
  interp: string;
}

function MetricCard({ cell }: { cell: MetricCell }) {
  return (
    <div className="rounded-lg border border-[#30363d] bg-[#161b22] p-4 print:bg-white print:border-black/20">
      <div className="text-[10px] uppercase tracking-[0.15em] text-[#8b949e] print:text-gray-600">
        {cell.label}
      </div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${signClass(cell.sign)}`}>
        {cell.value}
      </div>
      {cell.interp && (
        <div className="mt-1 text-[10px] text-[#6e7681] print:text-gray-500">{cell.interp}</div>
      )}
    </div>
  );
}

// ─── Performance ───────────────────────────────────────────────────────────

function Performance({ section }: { section: PerformanceSection }) {
  return (
    <Section kicker="02" title="Performance" summary={section.summary}>
      <KvList rows={[
        { label: 'Total P&L (net)', value: fmtSignedMoney(section.totalPnl), sign: signFromValue(section.totalPnl) },
        { label: 'Fees paid', value: `${fmtMoney(section.totalFees)} (already in net)` },
        { label: 'Funding', value: `${fmtMoney(section.totalFunding)} (already in net)` },
        { label: 'Win rate', value: fmtPct(section.winRate) },
        { label: 'Average win', value: fmtMoney(section.averageWin), sign: 'pos' },
        { label: 'Average loss', value: fmtMoney(section.averageLoss), sign: 'neg' },
        { label: 'Payoff ratio', value: fmtNum(section.payoffRatio, 2) },
      ]} />

      {(section.bestTrade || section.worstTrade) && (
        <>
          <Subheader>Best &amp; worst trades</Subheader>
          <KvList rows={[
            ...(section.bestTrade ? [{
              label: 'Best trade',
              value: `${section.bestTrade.asset} · ${fmtSignedMoney(section.bestTrade.pnl)} · ${fmtDate(section.bestTrade.date)}`,
              sign: 'pos' as const,
            }] : []),
            ...(section.worstTrade ? [{
              label: 'Worst trade',
              value: `${section.worstTrade.asset} · ${fmtSignedMoney(section.worstTrade.pnl)} · ${fmtDate(section.worstTrade.date)}`,
              sign: 'neg' as const,
            }] : []),
          ]} />
        </>
      )}

      {section.regimeBreakdown.length > 0 && (
        <>
          <Subheader>By regime</Subheader>
          <BreakdownTable rows={section.regimeBreakdown} />
        </>
      )}
      {section.tradeTypeBreakdown.length > 0 && (
        <>
          <Subheader>By trade type</Subheader>
          <BreakdownTable rows={section.tradeTypeBreakdown} />
        </>
      )}
    </Section>
  );
}

// ─── Behavioral ────────────────────────────────────────────────────────────

function Behavioral({ section }: { section: BehavioralSection }) {
  return (
    <Section kicker="03" title="Behavioural" summary={section.summary}>
      {section.syndromes && <SyndromesBlock syndromes={section.syndromes} />}

      {section.serialDependence && (
        <>
          <Subheader>Serial dependence</Subheader>
          <KvList rows={[
            { label: 'Loss after loss', value: fmtPct(section.serialDependence.lossAfterLoss) },
            { label: 'Win after win', value: fmtPct(section.serialDependence.winAfterWin) },
            { label: 'Loss after win', value: fmtPct(section.serialDependence.lossAfterWin) },
            { label: 'Win after loss', value: fmtPct(section.serialDependence.winAfterLoss) },
            { label: 'p-value', value: fmtP(section.serialDependence.pValue) },
            { label: 'Significant', value: section.serialDependence.isSignificant ? 'Yes' : 'No' },
          ]} />
          <Annotation>The outcome of your previous trade measurably affects your next trade.</Annotation>
        </>
      )}

      <Subheader>Revenge trading</Subheader>
      <KvList rows={[
        { label: 'Detected', value: section.revengeTradingSignals.detected ? 'Yes' : 'No' },
        {
          label: 'Size after loss',
          value: section.revengeTradingSignals.sizeAfterLoss
            ? `${section.revengeTradingSignals.sizeAfterLoss.change} (p=${section.revengeTradingSignals.sizeAfterLoss.pValue.toFixed(3)})`
            : '—',
        },
        {
          label: 'P&L after loss',
          value: section.revengeTradingSignals.pnlAfterLoss
            ? `${fmtSignedMoney(section.revengeTradingSignals.pnlAfterLoss.avgPnl)} (p=${section.revengeTradingSignals.pnlAfterLoss.pValue.toFixed(3)})`
            : '—',
          sign: section.revengeTradingSignals.pnlAfterLoss
            ? signFromValue(section.revengeTradingSignals.pnlAfterLoss.avgPnl)
            : undefined,
        },
      ]} />

      {section.dispositionEffect && (
        <>
          <Subheader>Disposition effect</Subheader>
          <KvList rows={[
            { label: 'Detected', value: section.dispositionEffect.detected ? 'Yes' : 'No' },
            { label: 'Winner hold (s)', value: fmtNum(section.dispositionEffect.winnerHoldTime, 0) },
            { label: 'Loser hold (s)', value: fmtNum(section.dispositionEffect.loserHoldTime, 0) },
            { label: 'Ratio (loser / winner)', value: fmtNum(section.dispositionEffect.ratio, 2) },
            { label: 'p-value', value: fmtP(section.dispositionEffect.pValue) },
          ]} />
        </>
      )}

      {section.tiltEpisodes && (
        <>
          <Subheader>Tilt episodes</Subheader>
          <KvList rows={[
            { label: 'Episode count', value: String(section.tiltEpisodes.count) },
            { label: 'Total cost', value: fmtSignedMoney(section.tiltEpisodes.totalCost), sign: signFromValue(section.tiltEpisodes.totalCost) },
            { label: 'Most common trigger', value: section.tiltEpisodes.mostCommonTrigger },
            { label: 'Avg duration (s)', value: String(section.tiltEpisodes.avgDuration) },
          ]} />
          <Annotation>
            Detected via CUSUM change-point analysis on trade frequency, position sizing, and hold times.
          </Annotation>
        </>
      )}

      {section.sessionFatigue && (
        <>
          <Subheader>Session fatigue</Subheader>
          <KvList rows={[
            { label: 'Significant', value: section.sessionFatigue.isSignificant ? 'Yes' : 'No' },
            {
              label: 'Optimal trade count',
              value: section.sessionFatigue.optimalTradeCount != null ? String(section.sessionFatigue.optimalTradeCount) : '—',
            },
            {
              label: 'Estimated savings',
              value: section.sessionFatigue.estimatedSavings != null ? fmtSignedMoney(section.sessionFatigue.estimatedSavings) : '—',
              sign: section.sessionFatigue.estimatedSavings != null ? signFromValue(section.sessionFatigue.estimatedSavings) : undefined,
            },
          ]} />
        </>
      )}

      {section.overtrading && (
        <>
          <Subheader>Overtrading</Subheader>
          <KvList rows={[
            { label: 'Correlation r', value: fmtNum(section.overtrading.correlationR, 3) },
            { label: 'Significant', value: section.overtrading.isSignificant ? 'Yes' : 'No' },
            { label: 'Heavy-day avg P&L', value: fmtSignedMoney(section.overtrading.heavyDayAvgPnl), sign: signFromValue(section.overtrading.heavyDayAvgPnl) },
            { label: 'Light-day avg P&L', value: fmtSignedMoney(section.overtrading.lightDayAvgPnl), sign: signFromValue(section.overtrading.lightDayAvgPnl) },
          ]} />
        </>
      )}

      {section.insights.length > 0 && (
        <>
          <Subheader>All behavioural insights</Subheader>
          <Table
            columns={[
              { header: 'Test', align: 'left' },
              { header: 'Finding', align: 'left' },
              { header: 'p', align: 'right' },
              { header: 'N', align: 'right' },
              { header: 'Sig.', align: 'right' },
            ]}
            rows={section.insights.map((i) => [
              { text: i.name },
              { text: i.finding },
              { text: fmtP(i.pValue) },
              { text: String(i.sampleSize) },
              { text: i.isSignificant ? 'Yes' : '—', tone: i.isSignificant ? 'pos' : 'muted' },
            ])}
          />
        </>
      )}

      <p className="mt-6 text-xs text-[#6e7681] print:text-gray-600 italic">
        Behavioural patterns are identified from statistical signals in your trading data —
        not clinical diagnoses.
      </p>
    </Section>
  );
}

// ─── Behavioural syndromes ─────────────────────────────────────────────────

type SyndromesBlockData = NonNullable<BehavioralSection['syndromes']>;
type SyndromeRow = SyndromesBlockData['results'][number];
type SyndromeSignal = SyndromeRow['requiredSignals'][number];

function SyndromesBlock({ syndromes }: { syndromes: SyndromesBlockData }) {
  const featured = syndromes.results.filter(
    (r) => r.confidence === 'moderate' || r.confidence === 'strong',
  );
  const others = syndromes.results.filter(
    (r) => r.confidence === 'weak' || r.confidence === 'absent',
  );

  return (
    <>
      <Subheader>Behavioural syndromes</Subheader>
      <p className="text-sm text-[#c9d1d9] print:text-black mb-4 leading-relaxed">
        {syndromes.overallAssessment}
      </p>

      {featured.length > 0 && (
        <div className="space-y-4">
          {featured.map((syn) => <SyndromeCard key={syn.name} syn={syn} />)}
        </div>
      )}

      {featured.length === 0 && (
        <p className="text-sm text-[#6e7681] italic mb-4">
          No syndromes were detected at moderate or strong confidence.
        </p>
      )}

      {others.length > 0 && (
        <>
          <Subheader>Other syndromes tested</Subheader>
          <Table
            columns={[
              { header: 'Syndrome', align: 'left' },
              { header: 'Confidence', align: 'left' },
              { header: 'Signals', align: 'right' },
              { header: 'Summary', align: 'left' },
            ]}
            rows={others.map((r) => [
              { text: r.displayName },
              { text: capitalize(r.confidence), tone: confidenceTone(r.confidence) },
              { text: `${r.presentCount}/${r.totalCount}` },
              { text: r.summary },
            ])}
          />
        </>
      )}
    </>
  );
}

function SyndromeCard({ syn }: { syn: SyndromeRow }) {
  const tone = confidenceTone(syn.confidence);
  return (
    <div className="rounded-lg border border-[#30363d] bg-[#161b22] p-5 print:bg-white print:border-black/20 break-inside-avoid">
      <div className="flex items-start justify-between gap-4 mb-2">
        <div>
          <div className="text-base font-semibold text-white print:text-black">{syn.displayName}</div>
          <div className="text-xs text-[#8b949e] print:text-gray-600 mt-0.5">
            {syn.presentCount} of {syn.totalCount} indicators present
          </div>
        </div>
        <ConfidenceBadge confidence={syn.confidence} tone={tone} />
      </div>

      <p className="text-sm text-[#c9d1d9] print:text-black leading-relaxed mb-4">{syn.summary}</p>

      <SignalChecklist label="Required" signals={syn.requiredSignals} />
      <SignalChecklist label="Supporting" signals={syn.supportingSignals} />
      {syn.contradictingSignals.some((s) => s.status === 'present') && (
        <SignalChecklist label="Contradicting" signals={syn.contradictingSignals} />
      )}

      {syn.intervention && (
        <div className="mt-4 rounded-md border border-blue-500/30 bg-blue-500/5 p-3 print:bg-blue-50 print:border-blue-300">
          <div className="text-[10px] uppercase tracking-wider text-[#58a6ff] print:text-blue-700 font-semibold mb-1">
            Recommendation
          </div>
          <div className="text-sm text-[#c9d1d9] print:text-black leading-relaxed">{syn.intervention}</div>
        </div>
      )}
    </div>
  );
}

function ConfidenceBadge({
  confidence,
  tone,
}: {
  confidence: SyndromeRow['confidence'];
  tone: Tone;
}) {
  const className = (() => {
    if (tone === 'pos') return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30 print:bg-emerald-100 print:text-emerald-800 print:border-emerald-300';
    if (tone === 'warn') return 'bg-amber-500/15 text-amber-300 border-amber-500/30 print:bg-amber-100 print:text-amber-800 print:border-amber-300';
    if (tone === 'neg') return 'bg-red-500/15 text-red-300 border-red-500/30 print:bg-red-100 print:text-red-800 print:border-red-300';
    if (tone === 'orange') return 'bg-orange-500/15 text-orange-300 border-orange-500/30 print:bg-orange-100 print:text-orange-800 print:border-orange-300';
    return 'bg-[#30363d] text-[#8b949e] border-[#30363d] print:bg-gray-100 print:text-gray-700 print:border-gray-300';
  })();
  return (
    <span className={`text-[10px] uppercase tracking-wider font-semibold px-2 py-1 rounded border whitespace-nowrap ${className}`}>
      {capitalize(confidence)}
    </span>
  );
}

function SignalChecklist({ label, signals }: { label: string; signals: SyndromeSignal[] }) {
  if (signals.length === 0) return null;
  return (
    <div className="mb-3">
      <div className="text-[10px] uppercase tracking-wider text-[#8b949e] print:text-gray-600 font-semibold mb-1.5">
        {label}
      </div>
      <ul className="space-y-1">
        {signals.map((sig) => (
          <li key={sig.name} className="flex items-start gap-2 text-sm">
            <span className={`mt-0.5 flex-shrink-0 w-4 inline-block text-[10px] font-bold ${signalClass(sig.status)}`}>
              {signalMark(sig.status)}
            </span>
            <span className="text-[#c9d1d9] print:text-black leading-snug">
              <span className="font-medium">{sig.displayName}</span>
              <span className="text-[#8b949e] print:text-gray-600"> — {sig.description}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function signalMark(status: SyndromeSignal['status']): string {
  if (status === 'present') return '✓';
  if (status === 'absent') return '–';
  return '?';
}

function signalClass(status: SyndromeSignal['status']): string {
  if (status === 'present') return 'text-emerald-400 print:text-emerald-700';
  if (status === 'absent') return 'text-[#6e7681] print:text-gray-500';
  return 'text-[#8b949e] print:text-gray-600';
}

// ─── Risk ──────────────────────────────────────────────────────────────────

function Risk({ section }: { section: RiskSection }) {
  const basisSuffix = section.usingDailyMetrics ? ' (daily)' : ' (per-trade)';
  const ratioRows: KvRow[] = [
    { label: `Sharpe${basisSuffix}`, value: fmtNum(section.sharpeRatio, 2), sign: signFromValue(section.sharpeRatio) },
    { label: `Sortino${basisSuffix}`, value: fmtNum(section.sortinoRatio, 2), sign: signFromValue(section.sortinoRatio) },
    { label: `Calmar${basisSuffix}`, value: fmtNum(section.calmarRatio, 2), sign: signFromValue(section.calmarRatio) },
    { label: 'Recovery factor', value: fmtNum(section.recoveryFactor, 2) },
    { label: 'Max drawdown ($)', value: fmtMoney(section.maxDrawdownDollars) },
    { label: 'Max drawdown (%)', value: fmtNum(section.maxDrawdownPct, 2) + '%' },
    { label: 'Current drawdown (%)', value: fmtNum(section.currentDrawdownPct, 2) + '%' },
  ];
  if (section.usingDailyMetrics) {
    if (section.ulcerIndex != null) ratioRows.push({ label: 'Ulcer index', value: fmtNum(section.ulcerIndex, 2) });
    if (section.maxDrawdownDurationDays != null) {
      ratioRows.push({ label: 'Max drawdown duration (days)', value: String(section.maxDrawdownDurationDays) });
    }
  }

  return (
    <Section kicker="04" title="Risk" summary={section.summary}>
      <KvList rows={ratioRows} />
      <Annotation>{section.methodologyNote}</Annotation>
      <Annotation>
        Sharpe = excess return per unit of total volatility. Sortino = downside-only volatility.
        Calmar = annualised return divided by max drawdown. Ulcer index = root-mean-square of daily
        drawdown percentages, capturing both depth and duration.
      </Annotation>

      {section.monteCarlo ? (
        <>
          <Subheader>Monte Carlo (10,000 sims · 100 trades forward)</Subheader>
          <KvList rows={[
            { label: 'P(drawdown ≥ 25%)', value: fmtPct(section.monteCarlo.probDrawdown25) },
            { label: 'P(drawdown ≥ 50%)', value: fmtPct(section.monteCarlo.probDrawdown50) },
            { label: 'P(ruin)', value: fmtPct(section.monteCarlo.probRuin) },
            { label: 'Median final balance', value: fmtMoney(section.monteCarlo.medianFinalBalance) },
            { label: '10th percentile', value: fmtMoney(section.monteCarlo.p10FinalBalance) },
            { label: '90th percentile', value: fmtMoney(section.monteCarlo.p90FinalBalance) },
          ]} />
          <Annotation>
            10,000 simulations of your next 100 trades, sampling from your actual return distribution.
          </Annotation>
        </>
      ) : (
        <p className="mt-4 text-sm text-[#8b949e] print:text-gray-600 italic">
          Monte Carlo unavailable — fewer than 20 closed trades with reconstructable equity.
        </p>
      )}
    </Section>
  );
}

// ─── Execution ─────────────────────────────────────────────────────────────

function Execution({ section }: { section: ExecutionSection }) {
  return (
    <Section kicker="05" title="Execution" summary={section.summary}>
      <KvList rows={[
        {
          label: 'Avg exit efficiency',
          value: section.avgExitEfficiency != null ? fmtPct(section.avgExitEfficiency) : '—',
        },
        { label: 'Avg MAE ($)', value: fmtNum(section.avgMae, 2) },
        { label: 'Avg MFE ($)', value: fmtNum(section.avgMfe, 2) },
        { label: 'Entry timing (|MAE| / MFE)', value: fmtNum(section.entryTimingScore, 3) },
      ]} />
      <Annotation>
        Exit efficiency is the share of the move you captured between entry and the trade&apos;s
        favourable extreme. Lower MAE/MFE means cleaner entries.
      </Annotation>

      {section.exitEfficiencyByRegime && section.exitEfficiencyByRegime.length > 0 && (
        <>
          <Subheader>Exit efficiency by regime</Subheader>
          <Table
            columns={[
              { header: 'Regime', align: 'left' },
              { header: 'Efficiency', align: 'right' },
              { header: 'Trades', align: 'right' },
            ]}
            rows={section.exitEfficiencyByRegime.map((r) => [
              { text: r.regime },
              { text: fmtPct(r.efficiency) },
              { text: String(r.tradeCount) },
            ])}
          />
        </>
      )}
    </Section>
  );
}

// ─── Regime ────────────────────────────────────────────────────────────────

function Regime({ section }: { section: RegimeSection }) {
  return (
    <Section kicker="06" title="Regime &amp; Edge Persistence" summary={section.summary}>
      <KvList rows={[{ label: 'Current BTC regime', value: section.currentRegime ?? '—' }]} />

      {section.performanceByRegime.length > 0 && (
        <>
          <Subheader>Performance by regime</Subheader>
          <BreakdownTable rows={section.performanceByRegime} />
        </>
      )}

      {section.edgePersistence && (
        <>
          <Subheader>Edge persistence (walk-forward)</Subheader>
          <KvList rows={[
            { label: 'Trend', value: section.edgePersistence.trend },
            { label: 'First-window avg', value: fmtSignedMoney(section.edgePersistence.firstAvg), sign: signFromValue(section.edgePersistence.firstAvg) },
            { label: 'Last-window avg', value: fmtSignedMoney(section.edgePersistence.lastAvg), sign: signFromValue(section.edgePersistence.lastAvg) },
          ]} />
          {section.edgePersistence.summary && (
            <p className="mt-3 text-sm text-[#c9d1d9] print:text-black leading-relaxed">
              {section.edgePersistence.summary}
            </p>
          )}
          <Annotation>
            Walk-forward edge persistence is descriptive at low window counts and may be unstable.
          </Annotation>
        </>
      )}

      {section.recommendations.length > 0 && (
        <>
          <Subheader>Recommendations</Subheader>
          <BulletList items={section.recommendations} variant="blue" />
        </>
      )}
    </Section>
  );
}

// ─── Methodology appendix ──────────────────────────────────────────────────

function Methodology({ section }: { section: MethodologySection }) {
  return (
    <Section kicker="07" title="Methodology">
      <p className="text-sm text-[#c9d1d9] print:text-black mb-6 leading-relaxed">
        All p-values are two-tailed. Multiple-comparison correction:
        Benjamini-Hochberg FDR at q=0.10 across all detectors.
      </p>

      <Subheader>Data sources</Subheader>
      <BulletList items={section.dataSources} variant="muted" />

      <Subheader>Known limitations</Subheader>
      <BulletList items={section.knownLimitations} variant="muted" />

      {section.entries.length > 0 && (
        <>
          <Subheader>Statistical tests</Subheader>
          <MethodologyTable entries={section.entries} />
          <Annotation>
            Confidence: <strong>Established</strong> = standard frequentist tests with broad
            consensus (Welch, chi-squared, BH). <strong>Adapted</strong> = domain-adapted methods
            on an established framework. <strong>Experimental</strong> = composite/synthesis
            layers built on top.
          </Annotation>
        </>
      )}
    </Section>
  );
}

function MethodologyTable({ entries }: { entries: MethodologyEntry[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-[#30363d] print:border-black/20">
      <table className="w-full text-xs">
        <thead className="bg-[#161b22] print:bg-gray-100">
          <tr className="text-left text-[10px] uppercase tracking-wider text-[#8b949e] print:text-gray-700">
            <th className="px-3 py-2 font-semibold">Test</th>
            <th className="px-3 py-2 font-semibold">Method</th>
            <th className="px-3 py-2 font-semibold text-right">Sample</th>
            <th className="px-3 py-2 font-semibold">Result</th>
            <th className="px-3 py-2 font-semibold">Finding</th>
            <th className="px-3 py-2 font-semibold">Confidence</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e, i) => (
            <tr
              key={i}
              className={`border-t border-[#30363d] print:border-black/10 ${
                i % 2 === 1 ? 'bg-[#0d1117] print:bg-white' : 'bg-[#0d1117]/50 print:bg-gray-50'
              }`}
            >
              <td className="px-3 py-2 align-top text-[#c9d1d9] print:text-black">{e.test}</td>
              <td className="px-3 py-2 align-top text-[#c9d1d9] print:text-black">{e.method}</td>
              <td className="px-3 py-2 align-top text-right text-[#c9d1d9] print:text-black tabular-nums">
                {e.sampleA}+{e.sampleB}
              </td>
              <td className="px-3 py-2 align-top text-[#c9d1d9] print:text-black">{e.result}</td>
              <td className={`px-3 py-2 align-top font-medium ${
                e.finding === 'Significant'
                  ? 'text-emerald-400 print:text-emerald-700'
                  : 'text-[#8b949e] print:text-gray-500'
              }`}>
                {e.finding}
              </td>
              <td className={`px-3 py-2 align-top font-medium ${methodologyConfidenceClass(e.confidence)}`}>
                {capitalize(e.confidence)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function methodologyConfidenceClass(c: MethodologyConfidence): string {
  if (c === 'established') return 'text-emerald-400 print:text-emerald-700';
  if (c === 'adapted') return 'text-amber-400 print:text-amber-700';
  return 'text-orange-400 print:text-orange-700';
}

// ─── Shared layout primitives ──────────────────────────────────────────────

interface KvRow {
  label: string;
  value: string;
  sign?: 'pos' | 'neg' | 'neutral';
}

function KvList({ rows }: { rows: KvRow[] }) {
  if (rows.length === 0) return null;
  return (
    <dl className="divide-y divide-[#30363d] print:divide-black/10 border border-[#30363d] print:border-black/20 rounded-lg overflow-hidden">
      {rows.map((row, i) => (
        <div key={i} className="grid grid-cols-3 px-4 py-2.5 text-sm even:bg-[#0d1117] odd:bg-[#161b22]/40 print:even:bg-white print:odd:bg-gray-50">
          <dt className="col-span-1 text-[#8b949e] print:text-gray-600">{row.label}</dt>
          <dd className={`col-span-2 tabular-nums ${signClass(row.sign ?? 'neutral')}`}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function BulletList({ items, variant }: { items: string[]; variant: 'green' | 'red' | 'blue' | 'muted' }) {
  const dotClass = (() => {
    if (variant === 'green') return 'bg-emerald-400 print:bg-emerald-600';
    if (variant === 'red') return 'bg-red-400 print:bg-red-600';
    if (variant === 'blue') return 'bg-blue-400 print:bg-blue-600';
    return 'bg-[#6e7681] print:bg-gray-500';
  })();
  return (
    <ul className="space-y-2">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-3 text-sm leading-relaxed">
          <span className={`mt-1.5 flex-shrink-0 w-1.5 h-1.5 rounded-full ${dotClass}`} />
          <span className="text-[#c9d1d9] print:text-black">{item}</span>
        </li>
      ))}
    </ul>
  );
}

function Annotation({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 text-xs text-[#6e7681] print:text-gray-600 leading-relaxed max-w-3xl">
      {children}
    </p>
  );
}

interface TableCol { header: string; align?: 'left' | 'right' }
interface TableCell { text: string; tone?: Tone }

function Table({ columns, rows }: { columns: TableCol[]; rows: TableCell[][] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-[#30363d] print:border-black/20">
      <table className="w-full text-sm">
        <thead className="bg-[#161b22] print:bg-gray-100">
          <tr className="text-[11px] uppercase tracking-wider text-[#8b949e] print:text-gray-700">
            {columns.map((c, i) => (
              <th
                key={i}
                className={`px-3 py-2 font-semibold ${c.align === 'right' ? 'text-right' : 'text-left'}`}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr
              key={ri}
              className={`border-t border-[#30363d] print:border-black/10 ${
                ri % 2 === 1 ? 'bg-[#0d1117] print:bg-white' : 'bg-[#0d1117]/50 print:bg-gray-50'
              }`}
            >
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  className={`px-3 py-2 align-top ${columns[ci].align === 'right' ? 'text-right tabular-nums' : ''} ${toneClass(cell.tone)}`}
                >
                  {cell.text}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BreakdownTable({ rows }: { rows: BreakdownRow[] }) {
  return (
    <Table
      columns={[
        { header: 'Sig.', align: 'left' },
        { header: 'Bucket', align: 'left' },
        { header: 'Trades', align: 'right' },
        { header: 'Win rate', align: 'right' },
        { header: 'Expect.', align: 'right' },
        { header: 'Total P&L', align: 'right' },
        { header: 'p', align: 'right' },
      ]}
      rows={rows.map((r) => [
        { text: r.isSignificant ? '✓' : '—', tone: r.isSignificant ? 'pos' : 'muted' },
        { text: r.label },
        { text: String(r.tradeCount) },
        { text: fmtPct(r.winRate) },
        { text: fmtSignedMoney(r.expectancy), tone: signFromValue(r.expectancy) === 'pos' ? 'pos' : signFromValue(r.expectancy) === 'neg' ? 'neg' : undefined },
        { text: fmtSignedMoney(r.totalPnl), tone: signFromValue(r.totalPnl) === 'pos' ? 'pos' : signFromValue(r.totalPnl) === 'neg' ? 'neg' : undefined },
        { text: fmtP(r.pValue) },
      ])}
    />
  );
}

// ─── Print styles ──────────────────────────────────────────────────────────

function PrintStyles() {
  return (
    <style>{`
      @media print {
        @page {
          margin: 0.6in;
        }
        html, body {
          background: white !important;
          color: black !important;
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
        }
        .no-print { display: none !important; }
        .page-break { break-before: page; page-break-before: always; }
        .page-break:first-of-type { break-before: auto; page-break-before: auto; }
        section, .break-inside-avoid {
          break-inside: avoid;
          page-break-inside: avoid;
        }
        a {
          color: inherit !important;
          text-decoration: none !important;
        }
      }
    `}</style>
  );
}

// ─── Formatters / classifiers ──────────────────────────────────────────────

type Tone = 'pos' | 'neg' | 'neutral' | 'muted' | 'warn' | 'orange';

function toneClass(tone?: Tone): string {
  if (tone === 'pos') return 'text-emerald-400 print:text-emerald-700';
  if (tone === 'neg') return 'text-red-400 print:text-red-700';
  if (tone === 'warn') return 'text-amber-400 print:text-amber-700';
  if (tone === 'orange') return 'text-orange-400 print:text-orange-700';
  if (tone === 'muted') return 'text-[#6e7681] print:text-gray-500';
  return 'text-[#c9d1d9] print:text-black';
}

function signClass(sign: 'pos' | 'neg' | 'neutral'): string {
  if (sign === 'pos') return 'text-emerald-400 print:text-emerald-700';
  if (sign === 'neg') return 'text-red-400 print:text-red-700';
  return 'text-[#c9d1d9] print:text-black';
}

function signFromValue(v: number | null | undefined): 'pos' | 'neg' | 'neutral' {
  if (v == null || !isFinite(v) || v === 0) return 'neutral';
  return v > 0 ? 'pos' : 'neg';
}

function confidenceTone(c: SyndromeRow['confidence']): Tone {
  if (c === 'absent') return 'pos';
  if (c === 'weak') return 'warn';
  if (c === 'moderate') return 'orange';
  return 'neg';
}

function tierColorClass(tier: string): string {
  const lower = (tier ?? '').toLowerCase();
  if (/elite|exceptional|excellent|above|good/.test(lower)) return 'text-emerald-400';
  if (/below|poor|weak|underperform|losing/.test(lower)) return 'text-red-400';
  return 'text-white';
}

function fmtNum(v: number | null | undefined, digits: number): string {
  if (v == null || !isFinite(v)) return '—';
  return v.toFixed(digits);
}

function fmtPct(v: number): string {
  if (!isFinite(v)) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

function fmtMoney(v: number): string {
  if (!isFinite(v)) return '—';
  const sign = v < 0 ? '-' : '';
  return `${sign}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtSignedMoney(v: number): string {
  if (!isFinite(v)) return '—';
  if (v > 0) {
    return `+$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (v < 0) {
    return `-$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return '$0.00';
}

function fmtP(v: number | null): string {
  if (v == null) return '—';
  if (v < 0.001) return 'p<0.001';
  return `p=${v.toFixed(3)}`;
}

function fmtDate(iso: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}

function fmtDateLong(iso: string): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

function truncateWallet(addr: string): string {
  if (!addr) return '—';
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

function capitalize(s: string): string {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function wartAxisLabel(key: string): string {
  if (key === 'timing') return 'Timing (TBD)';
  if (key === 'discipline') return 'Decision Consistency';
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function interpSharpe(v: number | null): string {
  if (v == null) return '';
  if (v < 0) return 'Below baseline';
  if (v < 1) return 'Marginal';
  return 'Strong';
}
function interpSortino(v: number | null): string {
  if (v == null) return '';
  if (v < 0) return 'Below baseline';
  if (v < 1) return 'Marginal';
  return 'Strong';
}
function interpCalmar(v: number | null): string {
  if (v == null) return '';
  if (v < 0.5) return 'Weak';
  if (v < 1) return 'Moderate';
  return 'Strong';
}
function interpWinRate(v: number): string {
  if (!isFinite(v)) return '';
  if (v < 0.40) return 'Below average';
  if (v < 0.55) return 'Average';
  return 'Strong';
}
function interpExpectancy(v: number): string {
  if (!isFinite(v)) return '';
  return v >= 0 ? 'Positive' : 'Negative';
}
function interpProfitFactor(v: number): string {
  if (!isFinite(v) || v === 0) return '';
  if (v < 1) return 'Losing';
  if (v < 1.5) return 'Marginal';
  return 'Profitable';
}
