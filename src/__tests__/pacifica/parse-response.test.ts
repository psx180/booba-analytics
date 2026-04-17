import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { PacificaBaseClient } from '@/services/pacifica/client';
import {
  PacificaAuthError,
  PacificaError,
  PacificaNotFoundError,
  PacificaRateLimitError,
  PacificaValidationError,
  PacificaServerError,
} from '@/services/pacifica/errors';

// parseResponse is a private method on PacificaBaseClient. Per the test plan
// we reach it through a test-only alias rather than modifying source.
type ParseFn = <T>(response: Response, schema: z.ZodType<T>) => Promise<T>;

function parseOf(client: PacificaBaseClient): ParseFn {
  return (client as unknown as { parseResponse: ParseFn }).parseResponse.bind(client);
}

function makeResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

const schema = z.object({ ok: z.boolean() });

describe('PacificaBaseClient.parseResponse', () => {
  let parse: ParseFn;

  beforeEach(() => {
    parse = parseOf(new PacificaBaseClient());
  });

  it('200 + valid JSON returns the parsed, schema-validated object', async () => {
    const result = await parse(makeResponse(200, JSON.stringify({ ok: true })), schema);
    expect(result).toEqual({ ok: true });
  });

  it('401 throws PacificaAuthError carrying the server message', async () => {
    const err = await parse(
      makeResponse(401, JSON.stringify({ error: 'bad signature' })),
      schema,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PacificaAuthError);
    expect((err as PacificaAuthError).message).toBe('bad signature');
    expect((err as PacificaAuthError).statusCode).toBe(401);
  });

  it('403 also throws PacificaAuthError', async () => {
    const err = await parse(makeResponse(403, '{}'), schema).catch((e) => e);
    expect(err).toBeInstanceOf(PacificaAuthError);
  });

  it('429 throws PacificaRateLimitError', async () => {
    const err = await parse(
      makeResponse(429, JSON.stringify({ error: 'slow down' })),
      schema,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PacificaRateLimitError);
    expect((err as PacificaRateLimitError).statusCode).toBe(429);
  });

  it('400 throws PacificaValidationError with the server message', async () => {
    const err = await parse(
      makeResponse(400, JSON.stringify({ error: 'bad field' })),
      schema,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PacificaValidationError);
    expect((err as PacificaValidationError).message).toBe('bad field');
  });

  it('404 throws PacificaNotFoundError', async () => {
    const err = await parse(makeResponse(404, '{}'), schema).catch((e) => e);
    expect(err).toBeInstanceOf(PacificaNotFoundError);
  });

  it('500 throws PacificaServerError', async () => {
    const err = await parse(makeResponse(500, '{}'), schema).catch((e) => e);
    expect(err).toBeInstanceOf(PacificaServerError);
  });

  it('non-JSON 200 body is wrapped in a PacificaError describing the raw text', async () => {
    const err = await parse(makeResponse(200, 'not json at all'), schema).catch((e) => e);
    expect(err).toBeInstanceOf(PacificaError);
    expect((err as PacificaError).message).toContain('Non-JSON response');
    expect((err as PacificaError).message).toContain('not json at all');
  });

  it('schema validation failure is reported as a PacificaError, not a raw ZodError', async () => {
    const err = await parse(
      makeResponse(200, JSON.stringify({ ok: 'yes' })), // wrong type
      schema,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PacificaError);
    expect((err as PacificaError).message).toContain('Response validation failed');
  });
});
