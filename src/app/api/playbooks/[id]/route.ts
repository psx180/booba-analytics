/**
 * PATCH  /api/playbooks/[id] — update name / description / rules.
 * DELETE /api/playbooks/[id] — delete the playbook. Positions tagged with
 *                              it are un-tagged (adherenceScore cleared)
 *                              so the analytics page doesn't show ghost
 *                              scores for a playbook that no longer exists.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { prisma } from '@/lib/prisma';
import type { PlaybookRule } from '@/services/playbooks/types';

async function ownedPlaybook(walletAddress: string, id: string) {
  const playbook = await prisma.playbook.findUnique({ where: { id } });
  if (!playbook) {
    return { ok: false as const, response: NextResponse.json({ error: 'Playbook not found' }, { status: 404 }) };
  }
  if (playbook.walletAddress !== walletAddress) {
    return { ok: false as const, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return { ok: true as const, playbook };
}

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

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (walletAddress) => {
    const { id } = await params;
    const owned = await ownedPlaybook(walletAddress, id);
    if (!owned.ok) return owned.response;

    let body: { name?: unknown; description?: unknown; rules?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const data: Record<string, string | null> = {};
    if ('name' in body) {
      if (typeof body.name !== 'string' || !body.name.trim()) {
        return NextResponse.json({ error: 'name must be a non-empty string' }, { status: 400 });
      }
      data.name = body.name.trim();
    }
    if ('description' in body) {
      data.description = typeof body.description === 'string' ? body.description : null;
    }
    if ('rules' in body) {
      const rules = sanitizeRules(body.rules);
      if (rules === null) {
        return NextResponse.json({ error: 'rules must be an array of { type, params, enabled, label }' }, { status: 400 });
      }
      data.rules = JSON.stringify(rules);
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
    }

    const playbook = await prisma.playbook.update({ where: { id }, data });
    return NextResponse.json({ playbook });
  });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (walletAddress) => {
    const { id } = await params;
    const owned = await ownedPlaybook(walletAddress, id);
    if (!owned.ok) return owned.response;

    // Clear the tag (and the now-meaningless score) from every position
    // that referenced this playbook before removing the row itself.
    await prisma.position.updateMany({
      where: { playbookId: id },
      data: { playbookId: null, adherenceScore: null, adherenceDetail: null },
    });
    await prisma.playbook.delete({ where: { id } });
    return NextResponse.json({ success: true });
  });
}
