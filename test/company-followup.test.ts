import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { applyCompanyModeSkeleton } from '../src/core/company-mode.ts';
import { applyCompanyLayout } from '../src/core/company-layout.ts';
import { ingestCompanyMeeting } from '../src/core/company-ingest.ts';
import { extractCompanyMemory } from '../src/core/company-extract.ts';
import {
  CompanyFollowUpError,
  COMPANY_FOLLOWUP_DISABLED_ACTIONS,
  draftCompanyFollowUp,
} from '../src/core/company-followup.ts';

let engine: PGLiteEngine;
let tmp: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await applyCompanyModeSkeleton(engine);
  await applyCompanyLayout(engine);
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-company-followup-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeFixture(name: string, content: string): string {
  const path = join(tmp, name);
  writeFileSync(path, content, 'utf-8');
  return path;
}

async function pageCount(): Promise<number> {
  const rows = await engine.executeRaw<{ count: number | string }>(
    `SELECT COUNT(*)::int AS count FROM pages WHERE source_id = $1`,
    ['company'],
  );
  return Number(rows[0]?.count ?? 0);
}

async function ingestAndExtractMeeting(input: {
  name: string;
  title: string;
  date: string;
  project: string;
  lines: string[];
}): Promise<void> {
  const transcript = writeFixture(input.name, [
    `${input.title} transcript`,
    '',
    ...input.lines,
  ].join('\n'));
  const ingest = await ingestCompanyMeeting(engine, {
    transcriptPath: transcript,
    title: input.title,
    date: input.date,
    projects: [input.project],
    noEmbed: true,
    now: new Date(`${input.date}T10:00:00Z`),
  });
  await extractCompanyMemory(engine, {
    slugs: [ingest.meeting.slug],
    noEmbed: true,
    now: new Date(`${input.date}T11:00:00Z`),
  });
}

describe('company follow-up drafting', () => {
  test('drafts follow-up from extracted commitments and actions without writing or executing', async () => {
    await ingestAndExtractMeeting({
      name: 'product-sync.txt',
      title: 'Product Sync',
      date: '2026-05-23',
      project: 'citation-refresh',
      lines: [
        'alice-example: We agreed to keep launch scoped to citation refresh.',
        'bob-example: I will send the follow-up summary.',
      ],
    });

    const before = await pageCount();
    const result = await draftCompanyFollowUp(engine);
    const after = await pageCount();

    expect(after).toBe(before);
    expect(result.source_id).toBe('company');
    expect(result.draft_mode).toBe('draft-only-local');
    expect(result.external_execution).toBe('disabled');
    expect(result.disabled_actions).toEqual([...COMPANY_FOLLOWUP_DISABLED_ACTIONS]);
    expect(result.disabled_actions).toContain('send_email');
    expect(result.disabled_actions).toContain('subagent_job');
    expect(result.disabled_surfaces).toContain('external_execution');
    expect(result.hosted_surface.skill_gate.default).toBe('deny');
    expect(result.hosted_surface.skill_gate.allowlist.map((rule) => rule.name)).toContain('query');
    expect(result.hosted_surface.skill_gate.allowlist.find((rule) => rule.name === 'brain-taxonomist')?.advisory_only).toBe(true);

    expect(result.decision_context).toHaveLength(1);
    expect(result.decision_context[0]?.decision).toContain('We agreed to keep launch scoped to citation refresh');
    expect(result.drafts.map((draft) => draft.kind).sort()).toEqual(['action', 'commitment']);
    expect(result.drafts.every((draft) => draft.owner === 'bob-example')).toBe(true);
    expect(result.drafts.every((draft) => draft.projects.includes('citation-refresh'))).toBe(true);
    expect(result.drafts[0]?.citations.map((citation) => citation.role)).toContain('follow_up');
    expect(result.drafts[0]?.citations.map((citation) => citation.role)).toContain('source');
    expect(result.drafts[0]?.citations.map((citation) => citation.role)).toContain('evidence');
    expect(result.draft_text).toContain('Draft follow-up (not sent or executed)');
    expect(result.draft_text).toContain('External execution is disabled');
    expect(result.draft_text).toContain('bob-example');
    expect(result.draft_text).toContain('send the follow-up summary');
  });

  test('filters follow-up drafts by owner and project', async () => {
    await ingestAndExtractMeeting({
      name: 'launch-sync.txt',
      title: 'Launch Sync',
      date: '2026-05-24',
      project: 'citation-refresh',
      lines: [
        'Decision: ship citation rendering before launch.',
        'bob-example: I will send the follow-up summary.',
      ],
    });
    await ingestAndExtractMeeting({
      name: 'ops-sync.txt',
      title: 'Ops Sync',
      date: '2026-05-24',
      project: 'ops-cleanup',
      lines: [
        'Decision: keep the on-call checklist in the trusted workspace.',
        'casey-example: I will send the follow-up checklist.',
      ],
    });

    const result = await draftCompanyFollowUp(engine, {
      owner: 'bob-example',
      project: 'citation-refresh',
    });

    expect(result.drafts).toHaveLength(2);
    expect(result.drafts.every((draft) => draft.owner === 'bob-example')).toBe(true);
    expect(result.drafts.every((draft) => draft.projects.includes('citation-refresh'))).toBe(true);
    expect(result.draft_text).toContain('citation rendering');
    expect(result.draft_text).not.toContain('on-call checklist');
    expect(result.draft_text).not.toContain('casey-example');
  });

  test('refuses drafting when company mode is not initialized', async () => {
    await resetPgliteState(engine);

    await expect(draftCompanyFollowUp(engine)).rejects.toThrow(CompanyFollowUpError);
  });
});
