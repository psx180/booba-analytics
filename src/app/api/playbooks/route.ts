/**
 * GET  /api/playbooks — list the wallet's playbooks (newest first).
 * POST /api/playbooks — create a playbook.
 *
 * Both gated on `withAuth`. The rules array is stored as JSON text so the
 * schema stays rigid while rule types evolve in code.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { prisma } from '@/lib/prisma';
import type { PlaybookRule } from '@/services/playbooks/types';

function sanitizeRules(raw: unknown): PlaybookRule[] | null {
  if (!Array.isArray(raw)) return null;
  const out: PlaybookRule[] = [];
  for (const r of raw) {
    if (
      r == null ||
      typeof r !== 'object' ||
      typeof (r as { type?: unknown }).type !== 'string' ||
      typeof (r as { params?: unknown }).params !== 'object' ||
      (r as { params?: unknown }).params === null
    ) {
      return null;
    }
    const rule = r as { type: string; params: Record<string, unknown>; enabled?: unknown; label?: unknown };
    out.push({
      type: rule.type,
      params: rule.params,
      enabled: rule.enabled !== false,
      label: typeof rule.label === 'string' && rule.label ? rule.label : rule.type,
    });
  }
  return out;
}

export async function GET(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    const playbooks = await prisma.playbook.findMany({
      where: { walletAddress },
      orderBy: { createdAt: 'desc' },
    });
    return NextResponse.json({ playbooks });
  });
}

export async function POST(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    let body: { name?: unknown; description?: unknown; rules?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    const rules = sanitizeRules(body.rules);
    if (rules === null) {
      return NextResponse.json({ error: 'rules must be an array of { type, params, enabled, label }' }, { status: 400 });
    }

    const playbook = await prisma.playbook.create({
      data: {
        walletAddress,
        name,
        description: typeof body.description === 'string' ? body.description : null,
        rules: JSON.stringify(rules),
      },
    });
    return NextResponse.json({ playbook }, { status: 201 });
  });
}
