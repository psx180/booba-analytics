/**
 * PDF rendering for TradingReport using pdfkit.
 *
 * Layout principles:
 *   - 72pt (1") margins on every side, white background, dark text
 *   - Strict spacing: ensureSpace before every block, paragraph gap 8pt,
 *     subsection gap 16pt, section gap 24pt, after-table gap 20pt
 *   - Section header = 18pt bold + colored underline rule
 *   - Subsection header = 14pt bold, no rule
 *   - Body = 10pt at 14pt line height
 *   - Tables: gray header bg, alternating row bg, 6pt vertical / 8pt horizontal
 *     padding, measured truncation, right-align numerics, signed P&L colored
 *   - Page X of Y + generator footer painted in a second pass via bufferPages
 *   - All section/page positioning is recomputed before each block — no
 *     "trust the cursor" dead reckoning that caused the original overlap bugs
 */

import PDFDocument from 'pdfkit';
import type { TradingReport, BreakdownRow, MethodologyEntry } from './types';

// ─── Page geometry ─────────────────────────────────────────────────────────

const PAGE_MARGIN = 72;            // 1 inch
const PAGE_WIDTH = 612;            // US Letter
const PAGE_HEIGHT = 792;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;     // 468pt
const CONTENT_BOTTOM = PAGE_HEIGHT - PAGE_MARGIN;        // y-coordinate of bottom margin
const FOOTER_AREA = 40;                                  // space reserved for the footer pass

// ─── Colors ────────────────────────────────────────────────────────────────

const COLOR_INK = '#1f2328';
const COLOR_MUTED = '#6e7681';
const COLOR_SUBTLE = '#8b949e';
const COLOR_RULE_DARK = '#2f4f7f';
const COLOR_RULE_LIGHT = '#d0d7de';
const COLOR_GREEN = '#1a7f37';
const COLOR_RED = '#cf222e';
const COLOR_BLUE = '#0969da';
const COLOR_YELLOW = '#bf8700';
const COLOR_ORANGE = '#bc4c00';
const COLOR_HEADER_BG = '#f0f0f0';
const COLOR_ZEBRA_BG = '#f9f9f9';

// ─── Spacing ───────────────────────────────────────────────────────────────

const PARA_GAP = 8;
const TABLE_AFTER_GAP = 20;
const SECTION_HEADER_GAP_BEFORE = 24;
const SECTION_HEADER_GAP_AFTER = 8;
const SUBSECTION_GAP_BEFORE = 16;
const SUBSECTION_GAP_AFTER = 6;

const BODY_FONT_SIZE = 10;
const BODY_LINE_HEIGHT = 14;

type Doc = PDFKit.PDFDocument;

// ═══════════════════════════════════════════════════════════════════════════
// Public entry
// ═══════════════════════════════════════════════════════════════════════════

export async function renderReportPdf(report: TradingReport): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: PAGE_MARGIN, bottom: PAGE_MARGIN, left: PAGE_MARGIN, right: PAGE_MARGIN },
    // bufferPages enables a second rendering pass for the footer/page-numbers.
    bufferPages: true,
    info: {
      Title: `Trading Report — ${report.walletAddress.slice(0, 8)}`,
      Author: 'BOOBAnalytics',
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

  // Second pass: paint footer (page X of Y + generator line) on every page.
  paintFooters(doc, report);

  doc.end();
  await finished;
  return Buffer.concat(chunks);
}

// ═══════════════════════════════════════════════════════════════════════════
// Cover page
// ═══════════════════════════════════════════════════════════════════════════

function drawCoverPage(doc: Doc, report: TradingReport): void {
  const blockTop = Math.round(PAGE_HEIGHT * 0.38) - 60;
  doc.fillColor(COLOR_INK);

  // Title.
  doc.font('Helvetica-Bold').fontSize(28);
  doc.text('Trading Report', PAGE_MARGIN, blockTop, { width: CONTENT_WIDTH });

  // Header rule below the title.
  const ruleY = blockTop + 44;
  doc.strokeColor(COLOR_RULE_DARK).lineWidth(1.5)
    .moveTo(PAGE_MARGIN, ruleY).lineTo(PAGE_MARGIN + CONTENT_WIDTH, ruleY).stroke();

  // Header metadata block.
  let y = ruleY + 16;
  doc.font('Helvetica').fontSize(12).fillColor(COLOR_MUTED);
  doc.text(`Wallet: ${truncateWallet(report.walletAddress)}`, PAGE_MARGIN, y);
  y = doc.y;
  doc.text(`Generated: ${formatDate(report.generatedAt)}`, PAGE_MARGIN, y);
  y = doc.y;
  doc.text(`Period: ${formatDate(report.period.from)} → ${formatDate(report.period.to)}`, PAGE_MARGIN, y);
  y = doc.y;
  doc.text(`Trades: ${report.tradeCount.toLocaleString()}`, PAGE_MARGIN, y);
  y = doc.y;
  doc.text(
    `Filters: ${report.filtersDescription || 'No filters — full trading history'}`,
    PAGE_MARGIN, y, { width: CONTENT_WIDTH },
  );

  // Composite Trader Score block.
  const cs = report.sections.executiveSummary?.compositeScore;
  if (cs) {
    const scoreTop = doc.y + 32;
    doc.font('Helvetica').fontSize(10).fillColor(COLOR_SUBTLE);
    doc.text('COMPOSITE TRADER SCORE', PAGE_MARGIN, scoreTop, { characterSpacing: 1.5 });

    const tierColor = colorForTier(cs.tier);
    doc.font('Helvetica-Bold').fontSize(64).fillColor(tierColor);
    doc.text(cs.score.toFixed(1), PAGE_MARGIN, scoreTop + 18);

    doc.font('Helvetica').fontSize(13).fillColor(COLOR_INK);
    doc.text(cs.tier, PAGE_MARGIN, scoreTop + 92);
  }

  // Cover footnote.
  doc.fillColor(COLOR_MUTED).font('Helvetica-Oblique').fontSize(9);
  const cFootY = PAGE_HEIGHT - PAGE_MARGIN - 56;
  doc.text(
    'The Composite Trader Score (inspired by baseball\'s Wins Above Replacement) ' +
    'aggregates entry, exit, risk, timing, and decision-consistency axes into a single number. ' +
    'See the methodology appendix for the full computation.',
    PAGE_MARGIN, cFootY, { width: CONTENT_WIDTH },
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Executive summary
// ═══════════════════════════════════════════════════════════════════════════

function drawExecutiveSummary(doc: Doc, report: TradingReport): void {
  const s = report.sections.executiveSummary!;
  startSection(doc, 'Executive Summary');

  // Metric grid (3×2).
  const m = s.headlineMetrics;
  drawMetricGrid(doc, [
    { label: 'Sharpe', value: fmtNum(m.sharpe, 2), interp: interpSharpe(m.sharpe) },
    { label: 'Sortino', value: fmtNum(m.sortino, 2), interp: interpSortino(m.sortino) },
    { label: 'Calmar', value: fmtNum(m.calmar, 2), interp: interpCalmar(m.calmar) },
    { label: 'Win rate', value: fmtPct(m.winRate), interp: interpWinRate(m.winRate) },
    { label: 'Expectancy', value: fmtMoney(m.expectancy), interp: interpExpectancy(m.expectancy) },
    { label: 'Profit factor', value: fmtNum(m.profitFactor, 2), interp: interpProfitFactor(m.profitFactor) },
  ]);

  // Annotation under the grid.
  drawAnnotation(doc,
    'Sharpe / Sortino / Calmar express return per unit of risk; values above 1 are strong, ' +
    'below 0 indicate negative risk-adjusted returns.',
  );

  // Hidden — Elo requires population calibration to be meaningful.
  // The eloRating field is intentionally null in the executive-summary section;
  // this guard keeps the PDF safe if it ever returns a value in the future.
  if (s.eloRating) {
    // Elo subsection intentionally suppressed.
  }

  if (s.compositeScore.axes && Object.keys(s.compositeScore.axes).length > 0) {
    drawSubsection(doc, 'Composite score axes');
    drawKvList(
      doc,
      Object.entries(s.compositeScore.axes).map(([k, v]) => [wartAxisLabel(k), fmtNum(v, 1)]),
    );
  }

  if (s.topStrengths.length > 0) {
    drawSubsection(doc, 'Top strengths');
    drawBullets(doc, s.topStrengths, COLOR_GREEN);
  }
  if (s.topWeaknesses.length > 0) {
    drawSubsection(doc, 'Top weaknesses');
    drawBullets(doc, s.topWeaknesses, COLOR_RED);
  }
  if (s.recommendations.length > 0) {
    drawSubsection(doc, 'Recommendations');
    drawBullets(doc, s.recommendations, COLOR_BLUE);
  }

  // Benchmark caveat footnote.
  ensureSpace(doc, 24);
  doc.moveDown(0.5);
  doc.font('Helvetica-Oblique').fontSize(8).fillColor(COLOR_MUTED);
  doc.text(
    'Interpretations are approximate benchmarks, not definitive assessments.',
    PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH },
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Performance
// ═══════════════════════════════════════════════════════════════════════════

function drawPerformance(doc: Doc, report: TradingReport): void {
  const s = report.sections.performance!;
  startSection(doc, 'Performance');
  drawSummary(doc, s.summary);

  drawKvList(doc, [
    ['Total P&L (net)', fmtSignedMoney(s.totalPnl)],
    ['Fees paid', `${fmtMoney(s.totalFees)} (already included in Total P&L)`],
    ['Funding', `${fmtMoney(s.totalFunding)} (already included in Total P&L)`],
    ['Win rate', fmtPct(s.winRate)],
    ['Average win', fmtMoney(s.averageWin)],
    ['Average loss', fmtMoney(s.averageLoss)],
    ['Payoff ratio', fmtNum(s.payoffRatio, 2)],
  ]);

  if (s.bestTrade || s.worstTrade) {
    drawSubsection(doc, 'Best & worst trades');
    const rows: Array<[string, string]> = [];
    if (s.bestTrade) {
      rows.push(['Best trade', `${s.bestTrade.asset} · ${fmtSignedMoney(s.bestTrade.pnl)} · ${formatDate(s.bestTrade.date)}`]);
    }
    if (s.worstTrade) {
      rows.push(['Worst trade', `${s.worstTrade.asset} · ${fmtSignedMoney(s.worstTrade.pnl)} · ${formatDate(s.worstTrade.date)}`]);
    }
    drawKvList(doc, rows);
  }

  if (s.regimeBreakdown.length > 0) {
    drawSubsection(doc, 'By regime');
    drawBreakdownTable(doc, s.regimeBreakdown);
  }
  if (s.tradeTypeBreakdown.length > 0) {
    drawSubsection(doc, 'By trade type');
    drawBreakdownTable(doc, s.tradeTypeBreakdown);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Behavioral
// ═══════════════════════════════════════════════════════════════════════════

function drawBehavioral(doc: Doc, report: TradingReport): void {
  const s = report.sections.behavioral!;
  startSection(doc, 'Behavioural');
  drawSummary(doc, s.summary);

  if (s.syndromes) drawSyndromes(doc, s.syndromes);

  if (s.serialDependence) {
    drawSubsection(doc, 'Serial dependence');
    drawKvList(doc, [
      ['Loss after loss', fmtPct(s.serialDependence.lossAfterLoss)],
      ['Win after win', fmtPct(s.serialDependence.winAfterWin)],
      ['Loss after win', fmtPct(s.serialDependence.lossAfterWin)],
      ['Win after loss', fmtPct(s.serialDependence.winAfterLoss)],
      ['p-value', fmtP(s.serialDependence.pValue)],
      ['Significant', s.serialDependence.isSignificant ? 'Yes' : 'No'],
    ]);
    drawAnnotation(doc, 'This means the outcome of your previous trade measurably affects your next trade.');
  }

  drawSubsection(doc, 'Revenge trading');
  const rt = s.revengeTradingSignals;
  drawKvList(doc, [
    ['Detected', rt.detected ? 'Yes' : 'No'],
    ['Size after loss', rt.sizeAfterLoss ? `${rt.sizeAfterLoss.change} (p=${rt.sizeAfterLoss.pValue.toFixed(3)})` : '—'],
    ['P&L after loss', rt.pnlAfterLoss ? `${fmtSignedMoney(rt.pnlAfterLoss.avgPnl)} (p=${rt.pnlAfterLoss.pValue.toFixed(3)})` : '—'],
  ]);

  if (s.dispositionEffect) {
    drawSubsection(doc, 'Disposition effect');
    drawKvList(doc, [
      ['Detected', s.dispositionEffect.detected ? 'Yes' : 'No'],
      ['Winner hold (s)', fmtNum(s.dispositionEffect.winnerHoldTime, 0)],
      ['Loser hold (s)', fmtNum(s.dispositionEffect.loserHoldTime, 0)],
      ['Ratio (loser / winner)', fmtNum(s.dispositionEffect.ratio, 2)],
      ['p-value', fmtP(s.dispositionEffect.pValue)],
    ]);
  }

  if (s.tiltEpisodes) {
    drawSubsection(doc, 'Tilt episodes');
    drawKvList(doc, [
      ['Episode count', String(s.tiltEpisodes.count)],
      ['Total cost', fmtSignedMoney(s.tiltEpisodes.totalCost)],
      ['Most common trigger', s.tiltEpisodes.mostCommonTrigger],
      ['Avg duration (s)', String(s.tiltEpisodes.avgDuration)],
    ]);
    drawAnnotation(doc,
      'Detected via CUSUM change-point analysis on trade frequency, position sizing, and hold times.');
  }

  if (s.sessionFatigue) {
    drawSubsection(doc, 'Session fatigue');
    drawKvList(doc, [
      ['Significant', s.sessionFatigue.isSignificant ? 'Yes' : 'No'],
      ['Optimal trade count', s.sessionFatigue.optimalTradeCount != null ? String(s.sessionFatigue.optimalTradeCount) : '—'],
      ['Estimated savings', s.sessionFatigue.estimatedSavings != null ? fmtSignedMoney(s.sessionFatigue.estimatedSavings) : '—'],
    ]);
  }

  if (s.overtrading) {
    drawSubsection(doc, 'Overtrading');
    drawKvList(doc, [
      ['Correlation r', fmtNum(s.overtrading.correlationR, 3)],
      ['Significant', s.overtrading.isSignificant ? 'Yes' : 'No'],
      ['Heavy-day avg P&L', fmtSignedMoney(s.overtrading.heavyDayAvgPnl)],
      ['Light-day avg P&L', fmtSignedMoney(s.overtrading.lightDayAvgPnl)],
    ]);
  }

  if (s.insights.length > 0) {
    drawSubsection(doc, 'All behavioural insights');
    drawTable(doc, [
      { header: 'Test', width: 130 },
      { header: 'Finding', width: 180 },
      { header: 'p', width: 60, align: 'right' },
      { header: 'N', width: 50, align: 'right' },
      { header: 'Sig.', width: 48, align: 'right' },
    ], s.insights.map((i) => ([
      { text: i.name },
      { text: i.finding },
      { text: fmtP(i.pValue) },
      { text: String(i.sampleSize) },
      // pdfkit's built-in Helvetica is WinAnsi-encoded, which doesn't include
    // U+2713 (✓). Use plain text labels so PDF viewers don't fall back to a
    // missing-glyph substitution character.
    { text: i.isSignificant ? 'Yes' : '—', color: i.isSignificant ? COLOR_GREEN : COLOR_MUTED },
    ])));
  }
}

// ─── Behavioural syndromes subsection ─────────────────────────────────────

function drawSyndromes(
  doc: Doc,
  syndromes: NonNullable<TradingReport['sections']['behavioral']>['syndromes'],
): void {
  if (!syndromes) return;

  drawSubsection(doc, 'Behavioural syndromes');

  // Disclaimer — these are statistical signals, not clinical diagnoses.
  drawAnnotation(doc,
    'Behavioral patterns are identified from statistical signals in your trading data. They are not clinical diagnoses.');

  // Overall assessment paragraph.
  ensureSpace(doc, 36);
  doc.font('Helvetica').fontSize(BODY_FONT_SIZE).fillColor(COLOR_INK);
  doc.text(syndromes.overallAssessment, PAGE_MARGIN, doc.y, {
    width: CONTENT_WIDTH,
    lineGap: BODY_LINE_HEIGHT - BODY_FONT_SIZE,
  });
  doc.y += PARA_GAP;

  // Per-syndrome detail blocks for confidence >= moderate; absent/weak get
  // a one-line entry in a compact table at the bottom so the reader still
  // sees what was tested.
  const featured = syndromes.results.filter(
    (r) => r.confidence === 'moderate' || r.confidence === 'strong',
  );
  const others = syndromes.results.filter(
    (r) => r.confidence === 'weak' || r.confidence === 'absent',
  );

  for (const syn of featured) {
    drawSyndromeBlock(doc, syn);
  }

  if (others.length > 0) {
    ensureSpace(doc, 24 + others.length * 16);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(COLOR_INK);
    doc.text('Other syndromes tested', PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.y += 4;
    drawTable(doc, [
      { header: 'Syndrome', width: 180 },
      { header: 'Confidence', width: 100 },
      { header: 'Signals', width: 80, align: 'right' },
      { header: 'Summary', width: CONTENT_WIDTH - 360 },
    ], others.map((r) => ([
      { text: r.displayName },
      { text: capitalize(r.confidence), color: confidenceColor(r.confidence) },
      { text: `${r.presentCount}/${r.totalCount}` },
      { text: r.summary },
    ])));
  }
}

type SyndromeRow = NonNullable<
  NonNullable<TradingReport['sections']['behavioral']>['syndromes']
>['results'][number];

function drawSyndromeBlock(doc: Doc, syn: SyndromeRow): void {
  ensureSpace(doc, 60);

  // Title row: name (bold) + colored confidence badge.
  doc.font('Helvetica-Bold').fontSize(12).fillColor(COLOR_INK);
  const titleY = doc.y;
  doc.text(syn.displayName, PAGE_MARGIN, titleY, { width: CONTENT_WIDTH - 140 });
  const titleHeight = doc.heightOfString(syn.displayName, { width: CONTENT_WIDTH - 140 });

  const badgeText = `${capitalize(syn.confidence)} confidence`;
  const badgeColor = confidenceColor(syn.confidence);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(badgeColor);
  const badgeWidth = doc.widthOfString(badgeText);
  doc.text(badgeText, PAGE_MARGIN + CONTENT_WIDTH - badgeWidth, titleY + 1, {
    width: badgeWidth,
  });
  doc.y = titleY + Math.max(titleHeight, 14) + 4;

  // Counts.
  doc.font('Helvetica').fontSize(9).fillColor(COLOR_MUTED);
  doc.text(`${syn.presentCount} of ${syn.totalCount} indicators present`, PAGE_MARGIN, doc.y, {
    width: CONTENT_WIDTH,
  });
  doc.y += 12;

  // Summary paragraph.
  doc.font('Helvetica').fontSize(BODY_FONT_SIZE).fillColor(COLOR_INK);
  doc.text(syn.summary, PAGE_MARGIN, doc.y, {
    width: CONTENT_WIDTH,
    lineGap: BODY_LINE_HEIGHT - BODY_FONT_SIZE,
  });
  doc.y += 6;

  // Checklist of signals.
  drawSyndromeChecklist(doc, 'Required', syn.requiredSignals);
  drawSyndromeChecklist(doc, 'Supporting', syn.supportingSignals);
  if (syn.contradictingSignals.some((sig) => sig.status === 'present')) {
    drawSyndromeChecklist(doc, 'Contradicting', syn.contradictingSignals);
  }

  // Intervention.
  if (syn.intervention) {
    ensureSpace(doc, 36);
    doc.font('Helvetica-Bold').fontSize(BODY_FONT_SIZE).fillColor(COLOR_INK);
    doc.text('Recommendation: ', PAGE_MARGIN, doc.y, { continued: true });
    doc.font('Helvetica').fillColor(COLOR_INK);
    doc.text(syn.intervention, {
      width: CONTENT_WIDTH,
      lineGap: BODY_LINE_HEIGHT - BODY_FONT_SIZE,
    });
    doc.y += 4;
  }

  doc.y += PARA_GAP;
}

function drawSyndromeChecklist(
  doc: Doc,
  label: string,
  signals: Array<{
    displayName: string;
    status: 'present' | 'absent' | 'insufficient_data';
    description: string;
  }>,
): void {
  if (signals.length === 0) return;
  ensureSpace(doc, 18 + signals.length * 14);

  doc.font('Helvetica-Bold').fontSize(9).fillColor(COLOR_MUTED);
  doc.text(label, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
  doc.y += 2;

  doc.font('Helvetica').fontSize(9);
  for (const sig of signals) {
    ensureSpace(doc, 14);
    const y = doc.y;
    const marker = signalMarker(sig.status);
    doc.fillColor(signalColor(sig.status));
    doc.text(marker, PAGE_MARGIN + 8, y, { width: 24 });
    doc.fillColor(COLOR_INK);
    doc.text(`${sig.displayName} — ${sig.description}`, PAGE_MARGIN + 32, y, {
      width: CONTENT_WIDTH - 32,
    });
    doc.y = y + 12;
  }
  doc.y += 4;
}

function signalMarker(status: 'present' | 'absent' | 'insufficient_data'): string {
  // pdfkit's built-in Helvetica is WinAnsi-encoded — no ✓/✗ glyphs available.
  // Use ASCII labels so all readers render reliably.
  if (status === 'present') return 'Yes';
  if (status === 'absent') return 'No';
  return 'n/a';
}

function signalColor(status: 'present' | 'absent' | 'insufficient_data'): string {
  if (status === 'present') return COLOR_GREEN;
  if (status === 'absent') return COLOR_MUTED;
  return COLOR_SUBTLE;
}

function confidenceColor(confidence: 'strong' | 'moderate' | 'weak' | 'absent'): string {
  if (confidence === 'absent') return COLOR_GREEN;
  if (confidence === 'weak') return COLOR_YELLOW;
  if (confidence === 'moderate') return COLOR_ORANGE;
  return COLOR_RED;
}

function capitalize(s: string): string {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ═══════════════════════════════════════════════════════════════════════════
// Risk
// ═══════════════════════════════════════════════════════════════════════════

function drawRisk(doc: Doc, report: TradingReport): void {
  const s = report.sections.risk!;
  startSection(doc, 'Risk');
  drawSummary(doc, s.summary);

  const basisSuffix = s.usingDailyMetrics ? ' (daily)' : ' (per-trade)';
  const ratioRows: [string, string][] = [
    [`Sharpe${basisSuffix}`, fmtNum(s.sharpeRatio, 2)],
    [`Sortino${basisSuffix}`, fmtNum(s.sortinoRatio, 2)],
    [`Calmar${basisSuffix}`, fmtNum(s.calmarRatio, 2)],
    ['Recovery factor', fmtNum(s.recoveryFactor, 2)],
    ['Max drawdown ($)', fmtMoney(s.maxDrawdownDollars)],
    ['Max drawdown (%)', fmtNum(s.maxDrawdownPct, 2)],
    ['Current drawdown (%)', fmtNum(s.currentDrawdownPct, 2)],
  ];
  if (s.usingDailyMetrics) {
    if (s.ulcerIndex != null) ratioRows.push(['Ulcer index', fmtNum(s.ulcerIndex, 2)]);
    if (s.maxDrawdownDurationDays != null) {
      ratioRows.push(['Max drawdown duration (days)', String(s.maxDrawdownDurationDays)]);
    }
  }
  drawKvList(doc, ratioRows);
  drawAnnotation(doc, s.methodologyNote);
  drawAnnotation(doc,
    'Sharpe = excess return per unit of total volatility. Sortino = excess return per unit of downside ' +
    'volatility only. Calmar = annualised return divided by max drawdown. Ulcer index = root-mean-square of ' +
    'daily drawdown percentages, capturing both depth and duration.');

  if (s.monteCarlo) {
    drawSubsection(doc, 'Monte Carlo (10,000 sims, 100 trades forward)');
    drawKvList(doc, [
      ['P(drawdown ≥25%)', fmtPct(s.monteCarlo.probDrawdown25)],
      ['P(drawdown ≥50%)', fmtPct(s.monteCarlo.probDrawdown50)],
      ['P(ruin)', fmtPct(s.monteCarlo.probRuin)],
      ['Median final balance', fmtMoney(s.monteCarlo.medianFinalBalance)],
      ['10th percentile', fmtMoney(s.monteCarlo.p10FinalBalance)],
      ['90th percentile', fmtMoney(s.monteCarlo.p90FinalBalance)],
    ]);
    drawAnnotation(doc,
      'Based on 10,000 simulations of your next 100 trades, sampling from your actual return distribution.');
  } else {
    ensureSpace(doc, 30);
    doc.font('Helvetica-Oblique').fontSize(BODY_FONT_SIZE).fillColor(COLOR_MUTED);
    doc.text('Monte Carlo unavailable — fewer than 20 closed trades with reconstructable equity.',
      PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.moveDown(PARA_GAP / BODY_LINE_HEIGHT);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Execution
// ═══════════════════════════════════════════════════════════════════════════

function drawExecution(doc: Doc, report: TradingReport): void {
  const s = report.sections.execution!;
  startSection(doc, 'Execution');
  drawSummary(doc, s.summary);

  drawKvList(doc, [
    ['Avg exit efficiency', s.avgExitEfficiency != null ? fmtPct(s.avgExitEfficiency) : '—'],
    ['Avg MAE ($)', fmtNum(s.avgMae, 2)],
    ['Avg MFE ($)', fmtNum(s.avgMfe, 2)],
    ['Entry timing (|MAE| / MFE)', fmtNum(s.entryTimingScore, 3)],
  ]);

  if (s.exitEfficiencyByRegime && s.exitEfficiencyByRegime.length > 0) {
    drawSubsection(doc, 'Exit efficiency by regime');
    drawTable(doc, [
      { header: 'Regime', width: 220 },
      { header: 'Efficiency', width: 120, align: 'right' },
      { header: 'Trades', width: 80, align: 'right' },
    ], s.exitEfficiencyByRegime.map((r) => ([
      { text: r.regime },
      { text: fmtPct(r.efficiency) },
      { text: String(r.tradeCount) },
    ])));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Regime
// ═══════════════════════════════════════════════════════════════════════════

function drawRegime(doc: Doc, report: TradingReport): void {
  const s = report.sections.regime!;
  startSection(doc, 'Regime & edge persistence');
  drawSummary(doc, s.summary);

  drawKvList(doc, [['Current BTC regime', s.currentRegime ?? '—']]);

  if (s.performanceByRegime.length > 0) {
    drawSubsection(doc, 'Performance by regime');
    drawBreakdownTable(doc, s.performanceByRegime);
  }

  if (s.edgePersistence) {
    drawSubsection(doc, 'Edge persistence (walk-forward)');
    drawKvList(doc, [
      ['Trend', s.edgePersistence.trend],
      ['First-window avg', fmtSignedMoney(s.edgePersistence.firstAvg)],
      ['Last-window avg', fmtSignedMoney(s.edgePersistence.lastAvg)],
    ]);
    if (s.edgePersistence.summary) {
      ensureSpace(doc, 28);
      doc.font('Helvetica').fontSize(BODY_FONT_SIZE).fillColor(COLOR_INK);
      doc.text(s.edgePersistence.summary, PAGE_MARGIN, doc.y, {
        width: CONTENT_WIDTH, lineGap: BODY_LINE_HEIGHT - BODY_FONT_SIZE,
      });
      doc.y += PARA_GAP;
    }
  }

  if (s.recommendations.length > 0) {
    drawSubsection(doc, 'Recommendations');
    drawBullets(doc, s.recommendations, COLOR_BLUE);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Methodology
// ═══════════════════════════════════════════════════════════════════════════

function drawMethodology(doc: Doc, report: TradingReport): void {
  const s = report.sections.methodology;
  startSection(doc, 'Methodology');

  // Header note.
  ensureSpace(doc, 32);
  doc.font('Helvetica').fontSize(BODY_FONT_SIZE).fillColor(COLOR_INK);
  doc.text(
    'All p-values are two-tailed. Multiple comparison correction: Benjamini-Hochberg FDR ' +
    'at q=0.10 across all detectors.',
    PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH, lineGap: BODY_LINE_HEIGHT - BODY_FONT_SIZE },
  );
  doc.y += PARA_GAP;

  drawSubsection(doc, 'Data sources');
  drawBullets(doc, s.dataSources, COLOR_MUTED);

  drawSubsection(doc, 'Known limitations');
  drawBullets(doc, s.knownLimitations, COLOR_MUTED);

  if (s.entries.length > 0) {
    drawSubsection(doc, 'Statistical tests');
    drawMethodologyTable(doc, s.entries);
  }
}

function drawMethodologyTable(doc: Doc, entries: MethodologyEntry[]): void {
  drawTable(doc, [
    { header: 'Test', width: 100 },
    { header: 'Method', width: 110 },
    { header: 'Sample', width: 50, align: 'right' },
    { header: 'Result', width: 95 },
    { header: 'Finding', width: 55 },
    { header: 'Confidence', width: 58 },
  ], entries.map((e) => ([
    { text: e.test },
    { text: e.method },
    { text: `${e.sampleA}+${e.sampleB}` },
    { text: e.result },
    { text: e.finding, color: e.finding === 'Significant' ? COLOR_GREEN : COLOR_MUTED },
    { text: capitalize(e.confidence), color: methodologyConfidenceColor(e.confidence) },
  ])), { fontSize: 8, lineHeight: 11, padV: 4, padH: 6 });

  // Legend so the column is interpretable without flipping back to the spec.
  drawAnnotation(doc,
    'Confidence: Established = standard frequentist tests with broad consensus (Welch, chi-squared, BH). ' +
    'Adapted = domain-adapted methods on an established framework (xPnL, BTC-proxy regimes, combinatorial search, Markov serial dependence). ' +
    'Experimental = composite/synthesis layers built on top (WART, decision-consistency entropy, low-power walk-forward).');
}

function methodologyConfidenceColor(c: 'established' | 'adapted' | 'experimental'): string {
  if (c === 'established') return COLOR_GREEN;
  if (c === 'adapted') return COLOR_YELLOW;
  return COLOR_ORANGE;
}

// ═══════════════════════════════════════════════════════════════════════════
// Section / subsection / summary primitives
// ═══════════════════════════════════════════════════════════════════════════

function startSection(doc: Doc, title: string): void {
  doc.addPage();
  doc.fillColor(COLOR_INK).font('Helvetica-Bold').fontSize(18);
  doc.text(title, PAGE_MARGIN, PAGE_MARGIN, { width: CONTENT_WIDTH });
  // Underline rule.
  const underY = doc.y + 4;
  doc.strokeColor(COLOR_RULE_DARK).lineWidth(1.2)
    .moveTo(PAGE_MARGIN, underY).lineTo(PAGE_MARGIN + 200, underY).stroke();
  doc.y = underY + SECTION_HEADER_GAP_AFTER + 4;
}

function drawSubsection(doc: Doc, title: string): void {
  ensureSpace(doc, SUBSECTION_GAP_BEFORE + 24);
  doc.y += SUBSECTION_GAP_BEFORE;
  doc.font('Helvetica-Bold').fontSize(14).fillColor(COLOR_INK);
  doc.text(title, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
  doc.y += SUBSECTION_GAP_AFTER;
}

function drawSummary(doc: Doc, text: string): void {
  if (!text) return;
  ensureSpace(doc, 36);
  doc.font('Helvetica-Oblique').fontSize(11).fillColor(COLOR_SUBTLE);
  doc.text(text, PAGE_MARGIN, doc.y, {
    width: CONTENT_WIDTH,
    lineGap: 3,
  });
  doc.y += 12;
}

function drawAnnotation(doc: Doc, text: string): void {
  ensureSpace(doc, 24);
  doc.font('Helvetica').fontSize(8).fillColor(COLOR_MUTED);
  doc.text(text, PAGE_MARGIN, doc.y, {
    width: CONTENT_WIDTH,
    lineGap: 2,
  });
  doc.y += PARA_GAP;
}

// ═══════════════════════════════════════════════════════════════════════════
// Key-value list (label : value) used in place of free paragraphs
// ═══════════════════════════════════════════════════════════════════════════

function drawKvList(doc: Doc, rows: [string, string][]): void {
  if (rows.length === 0) return;
  doc.font('Helvetica').fontSize(BODY_FONT_SIZE);
  const rowHeight = BODY_LINE_HEIGHT + 2;
  const labelW = 200;
  const valueW = CONTENT_WIDTH - labelW;

  for (const [k, v] of rows) {
    ensureSpace(doc, rowHeight);
    const y = doc.y;
    doc.fillColor(COLOR_MUTED).font('Helvetica');
    doc.text(k, PAGE_MARGIN, y, { width: labelW });
    doc.fillColor(signColorForString(v)).font('Helvetica');
    doc.text(v, PAGE_MARGIN + labelW, y, { width: valueW });
    doc.y = y + rowHeight;
  }
  doc.y += PARA_GAP;
}

// ═══════════════════════════════════════════════════════════════════════════
// Bullet lists
// ═══════════════════════════════════════════════════════════════════════════

function drawBullets(doc: Doc, items: string[], bulletColor: string): void {
  if (items.length === 0) return;
  doc.font('Helvetica').fontSize(BODY_FONT_SIZE);
  const indent = 20;
  const textWidth = CONTENT_WIDTH - indent;

  for (const item of items) {
    // Measure how tall the wrapped text will be so we can advance y precisely.
    const h = doc.heightOfString(item, { width: textWidth, lineGap: BODY_LINE_HEIGHT - BODY_FONT_SIZE });
    ensureSpace(doc, h + 6);
    const y = doc.y;
    doc.fillColor(bulletColor).text('•', PAGE_MARGIN + 4, y, { width: 12 });
    doc.fillColor(COLOR_INK).text(item, PAGE_MARGIN + indent, y, {
      width: textWidth, lineGap: BODY_LINE_HEIGHT - BODY_FONT_SIZE,
    });
    doc.y = y + h + 4;
  }
  doc.y += PARA_GAP;
}

// ═══════════════════════════════════════════════════════════════════════════
// Metric grid (3 columns × 2 rows)
// ═══════════════════════════════════════════════════════════════════════════

function drawMetricGrid(doc: Doc, cells: { label: string; value: string; interp: string }[]): void {
  const cols = 3;
  const gap = 12;
  const cellW = (CONTENT_WIDTH - gap * (cols - 1)) / cols;
  const cellH = 76;
  const rows = Math.ceil(cells.length / cols);

  ensureSpace(doc, rows * (cellH + gap));

  const startY = doc.y;
  for (let i = 0; i < cells.length; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const x = PAGE_MARGIN + c * (cellW + gap);
    const y = startY + r * (cellH + gap);

    // Border.
    doc.strokeColor(COLOR_RULE_LIGHT).lineWidth(0.5).rect(x, y, cellW, cellH).stroke();

    // Label.
    doc.font('Helvetica').fontSize(8).fillColor(COLOR_MUTED);
    doc.text(cells[i].label.toUpperCase(), x + 10, y + 10, {
      width: cellW - 20, characterSpacing: 1.2,
    });
    // Value.
    const valueColor = signColorForString(cells[i].value);
    doc.font('Helvetica-Bold').fontSize(20).fillColor(valueColor);
    doc.text(cells[i].value, x + 10, y + 26, { width: cellW - 20 });
    // Interpretation.
    if (cells[i].interp) {
      doc.font('Helvetica').fontSize(7).fillColor(COLOR_SUBTLE);
      doc.text(cells[i].interp, x + 10, y + 56, { width: cellW - 20 });
    }
  }
  doc.y = startY + rows * cellH + gap * (rows - 1) + PARA_GAP;
}

// ═══════════════════════════════════════════════════════════════════════════
// Generic table
// ═══════════════════════════════════════════════════════════════════════════

interface ColDef { header: string; width: number; align?: 'left' | 'right'; }
interface Cell { text: string; color?: string; }
interface TableOpts { fontSize?: number; lineHeight?: number; padV?: number; padH?: number; }

function drawTable(
  doc: Doc,
  cols: ColDef[],
  rows: Cell[][],
  opts: TableOpts = {},
): void {
  const fontSize = opts.fontSize ?? BODY_FONT_SIZE;
  const lineHeight = opts.lineHeight ?? BODY_LINE_HEIGHT;
  const padV = opts.padV ?? 6;
  const padH = opts.padH ?? 8;

  const totalWidth = cols.reduce((s, c) => s + c.width, 0);
  const tableLeft = PAGE_MARGIN;

  // Column x positions.
  const colX: number[] = [];
  let x = tableLeft;
  for (const c of cols) {
    colX.push(x);
    x += c.width;
  }

  // Pre-compute row heights so headers + zebra rects line up perfectly.
  doc.font('Helvetica-Bold').fontSize(fontSize);
  const headerHeight = lineHeight + padV * 2;

  // Draw header.
  ensureSpace(doc, headerHeight + 60);
  let y = doc.y;
  doc.rect(tableLeft, y, totalWidth, headerHeight).fillColor(COLOR_HEADER_BG).fill();
  doc.fillColor(COLOR_INK).font('Helvetica-Bold').fontSize(fontSize);
  for (let i = 0; i < cols.length; i++) {
    const text = truncateToWidth(doc, cols[i].header, cols[i].width - padH * 2);
    doc.text(text, colX[i] + padH, y + padV, {
      width: cols[i].width - padH * 2,
      align: cols[i].align ?? 'left',
    });
  }
  y += headerHeight;

  // Draw rows.
  doc.font('Helvetica').fontSize(fontSize);
  for (let r = 0; r < rows.length; r++) {
    // Truncate every cell to its column width and measure the tallest one.
    const truncated: Cell[] = [];
    let rowH = lineHeight + padV * 2;
    for (let i = 0; i < cols.length; i++) {
      const cell = rows[r][i] ?? { text: '' };
      const t = truncateToWidth(doc, cell.text, cols[i].width - padH * 2);
      truncated.push({ ...cell, text: t });
      const h = doc.heightOfString(t, { width: cols[i].width - padH * 2 }) + padV * 2;
      if (h > rowH) rowH = h;
    }

    if (y + rowH > CONTENT_BOTTOM - FOOTER_AREA) {
      // Continue the table on a new page (with header repeated).
      doc.addPage();
      y = doc.y;
      doc.rect(tableLeft, y, totalWidth, headerHeight).fillColor(COLOR_HEADER_BG).fill();
      doc.fillColor(COLOR_INK).font('Helvetica-Bold').fontSize(fontSize);
      for (let i = 0; i < cols.length; i++) {
        const text = truncateToWidth(doc, cols[i].header, cols[i].width - padH * 2);
        doc.text(text, colX[i] + padH, y + padV, {
          width: cols[i].width - padH * 2,
          align: cols[i].align ?? 'left',
        });
      }
      y += headerHeight;
      doc.font('Helvetica').fontSize(fontSize);
    }

    // Row background (zebra).
    if (r % 2 === 1) {
      doc.rect(tableLeft, y, totalWidth, rowH).fillColor(COLOR_ZEBRA_BG).fill();
    }

    // Bottom border.
    doc.strokeColor(COLOR_RULE_LIGHT).lineWidth(0.3)
      .moveTo(tableLeft, y + rowH).lineTo(tableLeft + totalWidth, y + rowH).stroke();

    // Cell text.
    for (let i = 0; i < cols.length; i++) {
      const cell = truncated[i];
      const color = cell.color ?? signColorForString(cell.text);
      doc.fillColor(color).font('Helvetica').fontSize(fontSize);
      doc.text(cell.text, colX[i] + padH, y + padV, {
        width: cols[i].width - padH * 2,
        align: cols[i].align ?? 'left',
      });
    }
    y += rowH;
  }

  doc.y = y + TABLE_AFTER_GAP - PARA_GAP;
  doc.y += PARA_GAP;
}

function drawBreakdownTable(doc: Doc, rows: BreakdownRow[]): void {
  drawTable(doc, [
    { header: 'Sig.',     width: 38, align: 'left' },
    { header: 'Bucket',   width: 120 },
    { header: 'Trades',   width: 50, align: 'right' },
    { header: 'Win rate', width: 60, align: 'right' },
    { header: 'Expect.',  width: 70, align: 'right' },
    { header: 'Total P&L',width: 80, align: 'right' },
    { header: 'p',        width: 50, align: 'right' },
  ], rows.map((r) => ([
    // 'Yes' / '—' instead of ✓ — see note above the behavioural-insights
    // table; built-in Helvetica can't encode the checkmark glyph.
    { text: r.isSignificant ? 'Yes' : '—', color: r.isSignificant ? COLOR_GREEN : COLOR_MUTED },
    { text: r.label },
    { text: String(r.tradeCount) },
    { text: fmtPct(r.winRate) },
    { text: fmtSignedMoney(r.expectancy) },
    { text: fmtSignedMoney(r.totalPnl) },
    { text: fmtP(r.pValue) },
  ])));
}

// ═══════════════════════════════════════════════════════════════════════════
// Footers (second pass)
// ═══════════════════════════════════════════════════════════════════════════

function paintFooters(doc: Doc, report: TradingReport): void {
  const range = doc.bufferedPageRange();
  const total = range.count;
  const generatedDate = formatDate(report.generatedAt);

  for (let i = 0; i < total; i++) {
    doc.switchToPage(range.start + i);
    const pageNum = i + 1;
    const footerY = PAGE_HEIGHT - PAGE_MARGIN + 24;

    doc.font('Helvetica').fontSize(8).fillColor(COLOR_MUTED);
    doc.text(`Page ${pageNum} of ${total}`, PAGE_MARGIN, footerY, {
      width: CONTENT_WIDTH, align: 'center',
    });
    doc.fontSize(7).fillColor(COLOR_SUBTLE);
    doc.text(`Generated by BOOBAnalytics • ${generatedDate}`, PAGE_MARGIN, footerY + 12, {
      width: CONTENT_WIDTH, align: 'center',
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function ensureSpace(doc: Doc, needed: number): void {
  if (doc.y + needed > CONTENT_BOTTOM - FOOTER_AREA) {
    doc.addPage();
  }
}

function truncateToWidth(doc: Doc, text: string, maxWidth: number): string {
  if (!text) return '';
  if (doc.widthOfString(text) <= maxWidth) return text;
  const ell = '…';
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (doc.widthOfString(text.slice(0, mid) + ell) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + ell;
}

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

/** Signed money — emits an explicit + prefix for positives so the sign-color
 *  logic and reader's eye both pick up the direction. */
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

function formatDate(iso: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}

function truncateWallet(addr: string): string {
  if (!addr) return '—';
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Color a rendered value by sign — looks for the explicit + or - prefix
 *  emitted by fmtSignedMoney. Plain numeric strings stay ink. */
function signColorForString(v: string): string {
  if (typeof v !== 'string') return COLOR_INK;
  const trimmed = v.trim();
  if (trimmed.startsWith('+$') || /^\+\d/.test(trimmed)) return COLOR_GREEN;
  if (trimmed.startsWith('-$') || /^-\d/.test(trimmed)) return COLOR_RED;
  return COLOR_INK;
}

function colorForTier(tier: string): string {
  const lower = (tier ?? '').toLowerCase();
  // WART tier strings come from tierFromWart() — they map cleanly to a
  // green/gray/red split based on whether the trader is above/at/below
  // average.
  if (/elite|exceptional|excellent|above|good/.test(lower)) return COLOR_GREEN;
  if (/below|poor|weak|underperform|losing/.test(lower)) return COLOR_RED;
  return COLOR_INK;
}

function titleCase(s: string): string {
  return s.replace(/^./, (c) => c.toUpperCase());
}

/** WART axis label override. Stored axis keys stay as 'timing'/'discipline'
 *  so the underlying composite weighting is unchanged; only the human label
 *  shifts.
 *  - Timing → 'Timing (TBD)' — session concentration is a weak skill
 *    dimension, pending redesign.
 *  - Discipline → 'Decision Consistency' — the entropy axis is a measure of
 *    decision spread, not a clinical "discipline" claim. */
function wartAxisLabel(key: string): string {
  if (key === 'timing') return 'Timing (TBD)';
  if (key === 'discipline') return 'Decision Consistency';
  return titleCase(key);
}

// ─── Metric interpretations ────────────────────────────────────────────────

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

