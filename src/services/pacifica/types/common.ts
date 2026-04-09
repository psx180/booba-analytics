import { z } from 'zod';

// ─── Envelope ─────────────────────────────────────────────────────────────────

export function apiResponse<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    success: z.boolean(),
    data: dataSchema,
    error: z.string().nullable().optional(),
    code: z.number().nullable().optional(),
  });
}

export function paginatedResponse<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    success: z.boolean(),
    data: z.array(dataSchema),
    next_cursor: z.string().nullable().optional(),
    has_more: z.boolean().optional(),
    error: z.string().nullable().optional(),
    code: z.number().nullable().optional(),
  });
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export interface SignatureHeader {
  type: string;
  timestamp: number;
  expiry_window: number;
}

export interface SignedRequestBase {
  account: string;
  signature: string;
  type: string;
  timestamp: number;
  expiry_window: number;
  agent_wallet?: string;
}

// ─── Shared primitives ────────────────────────────────────────────────────────

/** Pacifica returns numbers as decimal strings to preserve precision */
export const DecimalString = z.string();
export type DecimalString = z.infer<typeof DecimalString>;