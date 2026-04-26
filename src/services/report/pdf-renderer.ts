/**
 * PDF rendering for TradingReport using pdfkit.
 *
 * pdfkit ships with built-in core fonts (Helvetica), no external assets
 * needed. The renderer treats the report as immutable — it only reads —
 * and returns a Buffer ready for the API route to stream as a download.
 *
 * Layout: light theme, single column, monochrome accents. Cover page +
 * one heading per section + a methodology appendix. Tables are drawn
 * row-by-row since pdfkit has no native table widget.
 */

import PDFDocument from 'pdfkit';
import type { TradingReport, BreakdownRow, MethodologyEntry } from './types';

// Page metrics (US Letter @ 72dpi).
const PAGE_MARGIN = 56;
const PAGE_WIDTH = 612;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;

// Colour tokens.
const COLOR_INK = '#0d1117';
const COLOR_MUTED = '#6e7681';
const COLOR_RULE = '#d0d7de';
const COLOR_GREEN = '#1a7f37';
const COLOR_RED = '#cf222e';

type Doc = PDFKit.PDFDocument;

export async function renderReportPdf(report: TradingReport): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: PAGE_MARGIN, bottom: PAGE_MARGIN, left: PAGE_MARGIN, right: PAGE_MARGIN },
    info: {
      Title: `Trading Report — ${report.walletAddress.slice(0, 8)}`,
      Author: 'Booba',
      Subject: 'Trading performance and behavioural report',
      CreationDate: new Date(report.generatedAt),
    },
  });

  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const finished = new Promise<void>((resolve) => doc.on('end', () => resolve()));

  drawCoverPage(doc, report);

  const s = report.sections;
  if (s.executiveSummary) drawExecutiveSummary(doc, report);
  if (s.performance) drawPerformance(doc, report);
  if (s.behavioral) drawBehavioral(doc, report);
  if (s.risk) drawRisk(doc, report);
  if (s.execution) drawExecution(doc, report);
  if (s.regime) drawRegime(doc, report);
  drawMethodology(doc, report);

  doc.end();
  await finished;
  return Buffer.concat(chunks);
}

// ─── Cover page ────────────────────────────────────────────────────────────

function drawCoverPage(doc: Doc, report: TradingReport): void {
  doc.fillColor(COLOR_INK);

  doc.font('Helvetica-Bold').fontSize(36);
  doc.text('Trading Report', PAGE_MARGIN, 160);

  doc.font('Helvetica').fontSize(12).fillColor(COLOR_MUTED);
  doc.text(`Wallet: ${report.walletAddress}`, PAGE_MARGIN, 220);
  doc.text(`Generated: ${formatDate(report.generatedAt)}`, PAGE_MARGIN);
  doc.text(`Period: ${formatDate(report.period.from)} → ${formatDate(report.period.to)}`, PAGE_MARGIN);
  doc.text(`Trades included: ${report.tradeCount.toLocaleString()}`, PAGE_MARGIN);
  doc.text(
    `Filters: ${report.filtersDescription || 'No filters — full trading history'}`,
    PAGE_MARGIN,
    doc.y,
    { width: CONTENT_WIDTH },
  );

  // Composite Trader Score block, prominent.
  const cs = report.sections.executiveSummary?.compositeScore;
  if (cs) {
    doc.fillColor(COLOR_INK).font('Helvetica').fontSize(11);
    doc.text('COMPOSITE TRADER SCORE', PAGE_MARGIN, 360);
    doc.font('Helvetica-Bold').fontSize(72).fillColor(COLOR_INK);
    doc.text(cs.score.toFixed(1), PAGE_MARGIN, 380);
    doc.font('Helvetica').fontSize(14).fillColor(COLOR_MUTED);
    doc.text(cs.tier, PAGE_MARGIN, 470);
  }

  // Footer note explaining the metric.
  doc.fillColor(COLOR_MUTED).font('Helvetica-Oblique').fontSize(9);
  doc.text(
    'The Composite Trader Score (inspired by baseball\'s Wins Above Replacement) ' +
    'aggregates entry, exit, risk, timing, and discipline axes into a single number. ' +
    'See the methodology appendix for the full computation.',
    PAGE_MARGIN, 720, { width: CONTENT_WIDTH },
  );
}

// ─── Executive summary ─────────────────────────────────────────────────────

function drawExecutiveSummary(doc: Doc, report: TradingReport): void {
  const s = report.sections.executiveSummary!;
  startSection(doc, 'Executive Summary');

  // Headline metrics row.
  const m = s.headlineMetrics;
  drawKvGrid(doc, [
    ['Sharpe', fmtNum(m.sharpe, 2)],
    ['Sortino', fmtNum(m.sortino, 2)],
    ['Calmar', fmtNum(m.calmar, 2)],
    ['Win rate', fmtPct(m.winRate)],
    ['Expectancy', fmtMoney(m.expectancy)],
    ['Profit factor', fmtNum(m.profitFactor, 2)],
  ]);

  if (s.eloRating) {
    sectionHeading(doc, 'Elo rating');
    drawKvGrid(doc, [
      ['Current', String(s.eloRating.current)],
      ['Tier', s.eloRating.tier],
      ['Trend', s.eloRating.trend],
    ]);
  }

  if (s.compositeScore.axes && Object.keys(s.compositeScore.axes).length > 0) {
    sectionHeading(doc, 'Composite score axes');
    drawKvGrid(
      doc,
      Object.entries(s.compositeScore.axes).map(([k, v]) => [titleCase(k), fmtNum(v, 1)]),
    );
  }

  if (s.topStrengths.length > 0) {
    sectionHeading(doc, 'Top strengths');
    drawBullets(doc, s.topStrengths);
  }
  if (s.topWeaknesses.length > 0) {
    sectionHeading(doc, 'Top weaknesses');
    drawBullets(doc, s.topWeaknesses);
  }
  if (s.recommendations.length > 0) {
    sectionHeading(doc, 'Recommendations');
    drawBullets(doc, s.recommendations);
  }
}

// ─── Performance ───────────────────────────────────────────────────────────

function drawPerformance(doc: Doc, report: TradingReport): void {
  const s = report.sections.performance!;
  startSection(doc, 'Performance');
  drawKvGrid(doc, [
    ['Total P&L', fmtMoney(s.totalPnl)],
    ['Total fees', fmtMoney(s.totalFees)],
    ['Total funding', fmtMoney(s.totalFunding)],
    ['Net P&L', fmtMoney(s.netPnl)],
    ['Win rate', fmtPct(s.winRate)],
    ['Average win', fmtMoney(s.averageWin)],
    ['Average loss', fmtMoney(s.averageLoss)],
    ['Payoff ratio', fmtNum(s.payoffRatio, 2)],
  ]);

  if (s.bestTrade) {
    sectionHeading(doc, 'Best trade');
    drawKvGrid(doc, [
      ['Asset', s.bestTrade.asset],
      ['P&L', fmtMoney(s.bestTrade.pnl)],
      ['Date', formatDate(s.bestTrade.date)],
    ]);
  }
  if (s.worstTrade) {
    sectionHeading(doc, 'Worst trade');
    drawKvGrid(doc, [
      ['Asset', s.worstTrade.asset],
      ['P&L', fmtMoney(s.worstTrade.pnl)],
      ['Date', formatDate(s.worstTrade.date)],
    ]);
  }

  if (s.regimeBreakdown.length > 0) {
    sectionHeading(doc, 'By regime');
    drawBreakdownTable(doc, s.regimeBreakdown);
  }
  if (s.tradeTypeBreakdown.length > 0) {
    sectionHeading(doc, 'By trade type');
    drawBreakdownTable(doc, s.tradeTypeBreakdown);
  }
}

// ─── Behavioral ────────────────────────────────────────────────────────────

function drawBehavioral(doc: Doc, report: TradingReport): void {
  const s = report.sections.behavioral!;
  startSection(doc, 'Behavioural');

  if (s.serialDependence) {
    sectionHeading(doc, 'Serial dependence');
    drawKvGrid(doc, [
      ['Loss after loss', fmtPct(s.serialDependence.lossAfterLoss)],
      ['Win after win', fmtPct(s.serialDependence.winAfterWin)],
      ['Loss after win', fmtPct(s.serialDependence.lossAfterWin)],
      ['Win after loss', fmtPct(s.serialDependence.winAfterLoss)],
      ['p-value', fmtP(s.serialDependence.pValue)],
      ['Significant', s.serialDependence.isSignificant ? 'Yes' : 'No'],
    ]);
  }

  sectionHeading(doc, 'Revenge trading');
  const rt = s.revengeTradingSignals;
  drawKvGrid(doc, [
    ['Detected', rt.detected ? 'Yes' : 'No'],
    ['Size after loss', rt.sizeAfterLoss ? `${rt.sizeAfterLoss.change} (p=${rt.sizeAfterLoss.pValue.toFixed(3)})` : '—'],
    ['P&L after loss', rt.pnlAfterLoss ? `${fmtMoney(rt.pnlAfterLoss.avgPnl)} (p=${rt.pnlAfterLoss.pValue.toFixed(3)})` : '—'],
  ]);

  if (s.dispositionEffect) {
    sectionHeading(doc, 'Disposition effect');
    drawKvGrid(doc, [
      ['Detected', s.dispositionEffect.detected ? 'Yes' : 'No'],
      ['Winner hold (s)', fmtNum(s.dispositionEffect.winnerHoldTime, 0)],
      ['Loser hold (s)', fmtNum(s.dispositionEffect.loserHoldTime, 0)],
      ['Ratio (loser/winner)', fmtNum(s.dispositionEffect.ratio, 2)],
      ['p-value', fmtP(s.dispositionEffect.pValue)],
    ]);
  }

  if (s.tiltEpisodes) {
    sectionHeading(doc, 'Tilt episodes');
    drawKvGrid(doc, [
      ['Episode count', String(s.tiltEpisodes.count)],
      ['Total cost', fmtMoney(s.tiltEpisodes.totalCost)],
      ['Most common trigger', s.tiltEpisodes.mostCommonTrigger],
      ['Avg duration (s)', String(s.tiltEpisodes.avgDuration)],
    ]);
  }

  if (s.sessionFatigue) {
    sectionHeading(doc, 'Session fatigue');
    drawKvGrid(doc, [
      ['Significant', s.sessionFatigue.isSignificant ? 'Yes' : 'No'],
      ['Optimal trade count', s.sessionFatigue.optimalTradeCount != null ? String(s.sessionFatigue.optimalTradeCount) : '—'],
      ['Estimated savings', s.sessionFatigue.estimatedSavings != null ? fmtMoney(s.sessionFatigue.estimatedSavings) : '—'],
    ]);
  }

  if (s.overtrading) {
    sectionHeading(doc, 'Overtrading');
    drawKvGrid(doc, [
      ['Correlation r', fmtNum(s.overtrading.correlationR, 3)],
      ['Significant', s.overtrading.isSignificant ? 'Yes' : 'No'],
      ['Heavy-day avg P&L', fmtMoney(s.overtrading.heavyDayAvgPnl)],
      ['Light-day avg P&L', fmtMoney(s.overtrading.lightDayAvgPnl)],
    ]);
  }

  if (s.insights.length > 0) {
    sectionHeading(doc, 'All behavioural insights');
    drawTable(doc,
      ['Test', 'Finding', 'p', 'N', 'Sig.'],
      s.insights.map((i) => [
        i.name,
        truncate(i.finding, 60),
        fmtP(i.pValue),
        String(i.sampleSize),
        i.isSignificant ? '✓' : '—',
      ]),
      [120, 220, 50, 40, 40],
    );
  }
}

// ─── Risk ──────────────────────────────────────────────────────────────────

function drawRisk(doc: Doc, report: TradingReport): void {
  const s = report.sections.risk!;
  startSection(doc, 'Risk');
  drawKvGrid(doc, [
    ['Sharpe', fmtNum(s.sharpeRatio, 2)],
    ['Sortino', fmtNum(s.sortinoRatio, 2)],
    ['Calmar', fmtNum(s.calmarRatio, 2)],
    ['Recovery factor', fmtNum(s.recoveryFactor, 2)],
    ['Max drawdown ($)', fmtMoney(s.maxDrawdownDollars)],
    ['Max drawdown (%)', fmtNum(s.maxDrawdownPct, 2)],
    ['Current drawdown (%)', fmtNum(s.currentDrawdownPct, 2)],
  ]);

  if (s.monteCarlo) {
    sectionHeading(doc, 'Monte Carlo (10,000 sims, 100 trades forward)');
    drawKvGrid(doc, [
      ['P(drawdown ≥25%)', fmtPct(s.monteCarlo.probDrawdown25)],
      ['P(drawdown ≥50%)', fmtPct(s.monteCarlo.probDrawdown50)],
      ['P(ruin)', fmtPct(s.monteCarlo.probRuin)],
      ['Median final balance', fmtMoney(s.monteCarlo.medianFinalBalance)],
      ['10th percentile', fmtMoney(s.monteCarlo.p10FinalBalance)],
      ['90th percentile', fmtMoney(s.monteCarlo.p90FinalBalance)],
    ]);
  } else {
    doc.font('Helvetica-Oblique').fontSize(10).fillColor(COLOR_MUTED);
    doc.text('Monte Carlo unavailable — fewer than 20 closed trades with reconstructable equity.');
  }
}

// ─── Execution ─────────────────────────────────────────────────────────────

function drawExecution(doc: Doc, report: TradingReport): void {
  const s = report.sections.execution!;
  startSection(doc, 'Execution');
  drawKvGrid(doc, [
    ['Avg exit efficiency', s.avgExitEfficiency != null ? fmtPct(s.avgExitEfficiency) : '—'],
    ['Avg MAE ($)', fmtNum(s.avgMae, 2)],
    ['Avg MFE ($)', fmtNum(s.avgMfe, 2)],
    ['Entry timing (|MAE|/MFE)', fmtNum(s.entryTimingScore, 3)],
  ]);

  if (s.exitEfficiencyByRegime && s.exitEfficiencyByRegime.length > 0) {
    sectionHeading(doc, 'Exit efficiency by regime');
    drawTable(doc,
      ['Regime', 'Efficiency', 'Trades'],
      s.exitEfficiencyByRegime.map((r) => [
        r.regime,
        fmtPct(r.efficiency),
        String(r.tradeCount),
      ]),
      [240, 100, 80],
    );
  }
}

// ─── Regime ────────────────────────────────────────────────────────────────

function drawRegime(doc: Doc, report: TradingReport): void {
  const s = report.sections.regime!;
  startSection(doc, 'Regime & edge persistence');
  drawKvGrid(doc, [
    ['Current BTC regime', s.currentRegime ?? '—'],
  ]);

  if (s.performanceByRegime.length > 0) {
    sectionHeading(doc, 'Performance by regime');
    drawBreakdownTable(doc, s.performanceByRegime);
  }

  if (s.edgePersistence) {
    sectionHeading(doc, 'Edge persistence (walk-forward)');
    drawKvGrid(doc, [
      ['Trend', s.edgePersistence.trend],
      ['First-window avg', fmtMoney(s.edgePersistence.firstAvg)],
      ['Last-window avg', fmtMoney(s.edgePersistence.lastAvg)],
    ]);
    if (s.edgePersistence.summary) {
      doc.font('Helvetica').fontSize(10).fillColor(COLOR_INK);
      doc.moveDown(0.4);
      doc.text(s.edgePersistence.summary, { width: CONTENT_WIDTH });
    }
  }

  if (s.recommendations.length > 0) {
    sectionHeading(doc, 'Recommendations');
    drawBullets(doc, s.recommendations);
  }
}

// ─── Methodology ───────────────────────────────────────────────────────────

function drawMethodology(doc: Doc, report: TradingReport): void {
  const s = report.sections.methodology;
  startSection(doc, 'Methodology');

  doc.font('Helvetica').fontSize(10).fillColor(COLOR_INK);
  doc.text(`Correction: ${s.correctionMethod}`, { width: CONTENT_WIDTH });
  doc.moveDown(0.5);

  sectionHeading(doc, 'Data sources');
  drawBullets(doc, s.dataSources);

  sectionHeading(doc, 'Known limitations');
  drawBullets(doc, s.knownLimitations);

  if (s.entries.length > 0) {
    sectionHeading(doc, 'Statistical tests');
    drawMethodologyTable(doc, s.entries);
  }
}

// ─── Drawing primitives ───────────────────────────────────────────────────

function startSection(doc: Doc, title: string): void {
  doc.addPage();
  doc.fillColor(COLOR_INK).font('Helvetica-Bold').fontSize(20);
  doc.text(title, PAGE_MARGIN, PAGE_MARGIN);
  doc.moveTo(PAGE_MARGIN, doc.y + 4).lineTo(PAGE_WIDTH - PAGE_MARGIN, doc.y + 4)
    .strokeColor(COLOR_RULE).lineWidth(0.5).stroke();
  doc.moveDown(1);
}

function sectionHeading(doc: Doc, title: string): void {
  ensureSpace(doc, 60);
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(COLOR_INK);
  doc.text(title);
  doc.moveDown(0.2);
}

function drawKvGrid(doc: Doc, rows: [string, string][]): void {
  ensureSpace(doc, 20 * rows.length);
  doc.font('Helvetica').fontSize(10);
  const labelW = 180;
  for (const [k, v] of rows) {
    const y = doc.y;
    doc.fillColor(COLOR_MUTED).text(k, PAGE_MARGIN, y, { width: labelW, continued: false });
    doc.fillColor(valueColor(v)).text(v, PAGE_MARGIN + labelW, y, { width: CONTENT_WIDTH - labelW });
  }
  doc.moveDown(0.3);
}

function drawBullets(doc: Doc, items: string[]): void {
  doc.font('Helvetica').fontSize(10).fillColor(COLOR_INK);
  for (const item of items) {
    ensureSpace(doc, 28);
    doc.text(`• ${item}`, PAGE_MARGIN + 6, doc.y, { width: CONTENT_WIDTH - 6 });
  }
  doc.moveDown(0.4);
}

function drawTable(
  doc: Doc,
  headers: string[],
  rows: string[][],
  colWidths: number[],
): void {
  drawTableRow(doc, headers, colWidths, true);
  for (const r of rows) {
    ensureSpace(doc, 16);
    drawTableRow(doc, r, colWidths, false);
  }
  doc.moveDown(0.4);
}

function drawTableRow(
  doc: Doc,
  cells: string[],
  colWidths: number[],
  header: boolean,
): void {
  const y = doc.y;
  let x = PAGE_MARGIN;
  doc.font(header ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
  doc.fillColor(header ? COLOR_INK : COLOR_INK);
  for (let i = 0; i < cells.length; i++) {
    doc.fillColor(header ? COLOR_INK : valueColor(cells[i]));
    doc.text(cells[i], x + 2, y + 2, { width: colWidths[i] - 4 });
    x += colWidths[i];
  }
  // Move below the tallest cell.
  doc.y = y + 14;
  doc.strokeColor(COLOR_RULE).lineWidth(0.3)
    .moveTo(PAGE_MARGIN, doc.y).lineTo(PAGE_MARGIN + colWidths.reduce((s, w) => s + w, 0), doc.y).stroke();
  doc.y += 2;
}

function drawBreakdownTable(doc: Doc, rows: BreakdownRow[]): void {
  drawTable(
    doc,
    ['Bucket', 'Trades', 'Win rate', 'Expectancy', 'Total P&L', 'p', 'Sig.'],
    rows.map((r) => [
      r.label,
      String(r.tradeCount),
      fmtPct(r.winRate),
      fmtMoney(r.expectancy),
      fmtMoney(r.totalPnl),
      fmtP(r.pValue),
      r.isSignificant ? '✓' : '—',
    ]),
    [140, 50, 60, 80, 80, 50, 40],
  );
}

function drawMethodologyTable(doc: Doc, entries: MethodologyEntry[]): void {
  drawTable(
    doc,
    ['Test', 'Method', 'Result', 'Finding'],
    entries.map((e) => [
      e.test,
      truncate(e.method, 38),
      e.result,
      e.finding,
    ]),
    [140, 140, 130, 90],
  );
}

function ensureSpace(doc: Doc, needed: number): void {
  if (doc.y + needed > doc.page.height - PAGE_MARGIN) {
    doc.addPage();
  }
}

// ─── Formatting helpers ───────────────────────────────────────────────────

function fmtNum(v: number | null, digits: number): string {
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

function fmtP(v: number | null): string {
  if (v == null) return '—';
  if (v < 0.001) return 'p<0.001';
  return `p=${v.toFixed(3)}`;
}

function formatDate(iso: string): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}

function valueColor(v: string): string {
  if (typeof v !== 'string') return COLOR_INK;
  if (v.startsWith('-$') || v.startsWith('-')) return COLOR_RED;
  if (v.startsWith('$') || (v.startsWith('+') && v.includes('$'))) return COLOR_GREEN;
  return COLOR_INK;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function titleCase(s: string): string {
  return s.replace(/^./, (c) => c.toUpperCase());
}
