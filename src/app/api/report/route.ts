import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { parseFilters } from '@/app/api/analytics/_filters';
import { generateReport } from '@/services/report/report-service';
import { renderReportPdf } from '@/services/report/pdf-renderer';

/**
 * GET /api/report
 *
 * Query params:
 *   journalId          — optional; falls back to the wallet's default journal
 *   format=json|pdf    — default 'json'
 *   regime, asset, tradeType, builderCode, builderCodeExclude,
 *   manualOnly, excludeBuilderCodes, dateFrom, dateTo  — same params
 *                         the analytics API consumes; the report covers
 *                         exactly the filtered population.
 */
export async function GET(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    const sp = req.nextUrl.searchParams;
    const format = (sp.get('format') ?? 'json').toLowerCase();
    const journalId = sp.get('journalId') ?? undefined;

    // Reuse the analytics API's filter parser so URL params behave the same
    // way they do everywhere else (CSV blocklist, manualOnly flag, etc.).
    const filters = parseFilters(sp);

    const report = await generateReport(walletAddress, journalId, filters);

    if (format === 'pdf') {
      const pdfBuffer = await renderReportPdf(report);
      const datePart = report.generatedAt.slice(0, 10);
      const filename = `trading-report-${walletAddress.slice(0, 8)}-${datePart}.pdf`;
      // Hand the Node Buffer to NextResponse as a Blob — BodyInit accepts
      // Blob but the TS surface for Buffer/Uint8Array is mismatched against
      // the lib.dom shape Next.js targets.
      const blob = new Blob([new Uint8Array(pdfBuffer)], { type: 'application/pdf' });
      return new NextResponse(blob, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    return NextResponse.json(report);
  });
}
