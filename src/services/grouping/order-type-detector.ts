/**
 * OrderTypeDetector — strategy-pattern chain for determining order execution type.
 *
 * Two implementations:
 *   1. ApiOrderTypeDetector  — reads `order_type` / `type` from Pacifica raw data
 *      (authoritative when present — the exchange knows best).
 *   2. StoredTypeDetector    — falls back to the `tradeType` column set by the
 *      heuristic classifiers (TwapClassifier / PartialFillClassifier / etc.)
 *      during the grouping import pipeline.
 *
 * DetectorChain runs them in order and returns the first non-null result.
 */

export interface OrderTypeDetectable {
  tradeType: string | null;
  firstFillRawData?: string | null;
}

export interface OrderTypeDetector {
  detect(order: OrderTypeDetectable): string | null;
}

// ── API detector ─────────────────────────────────────────────────────────────

/**
 * Reads the Pacifica `order_type` (or legacy `type`) field from the first
 * fill's raw JSON payload. Returns null when the field is absent.
 */
export class ApiOrderTypeDetector implements OrderTypeDetector {
  detect(order: OrderTypeDetectable): string | null {
    if (!order.firstFillRawData) return null;
    try {
      const raw = JSON.parse(order.firstFillRawData) as Record<string, unknown>;
      const val = raw.order_type ?? raw.type;
      return typeof val === 'string' && val ? val : null;
    } catch {
      return null;
    }
  }
}

// ── Stored heuristic detector ─────────────────────────────────────────────────

/**
 * Returns the `tradeType` that was computed by the heuristic classifier chain
 * (TwapClassifier / PartialFillClassifier / SingleOrderClassifier) when the
 * fills were first ingested. Acts as a reliable fallback when the exchange API
 * doesn't expose a structured order type.
 */
export class StoredTypeDetector implements OrderTypeDetector {
  detect(order: OrderTypeDetectable): string | null {
    return order.tradeType ?? null;
  }
}

// ── Chained detector ─────────────────────────────────────────────────────────

/**
 * Runs each detector in order and returns the first non-null result.
 * The default instance is ApiOrderTypeDetector → StoredTypeDetector.
 */
export class DetectorChain implements OrderTypeDetector {
  constructor(private readonly detectors: OrderTypeDetector[]) {}

  detect(order: OrderTypeDetectable): string | null {
    for (const d of this.detectors) {
      const result = d.detect(order);
      if (result) return result;
    }
    return null;
  }
}

export function createDefaultOrderTypeDetector(): OrderTypeDetector {
  return new DetectorChain([new ApiOrderTypeDetector(), new StoredTypeDetector()]);
}
