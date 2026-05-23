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
  answerCompanyQuestion,
  CompanyRetrieveError,
  COMPANY_RETRIEVAL_DISABLED_SURFACES,
} from '../src/core/company-retrieve.ts';

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
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-company-retrieve-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeFixture(name: string, content: string): string {
  const path = join(tmp, name);
  writeFileSync(path, content, 'utf-8');
  return path;
}

async function ingestAndExtractMeeting(
  name: string,
  title: string,
  date: string,
  project: string,
  decisionLine: string,
): Promise<string> {
  const transcript = writeFixture(name, [
    `${title} transcript`,
    '',
    decisionLine,
  ].join('\n'));
  const ingest = await ingestCompanyMeeting(engine, {
    transcriptPath: transcript,
    title,
    date,
    projects: [project],
    noEmbed: true,
    now: new Date(`${date}T10:00:00Z`),
  });
  await extractCompanyMemory(engine, {
    slugs: [ingest.meeting.slug],
    noEmbed: true,
    now: new Date(`${date}T11:00:00Z`),
  });
  return ingest.meeting.slug;
}

describe('company retrieval and citations', () => {
  test('answers what we decided with decision, source, and evidence citations', async () => {
    const meetingSlug = await ingestAndExtractMeeting(
      'product-sync.txt',
      'Product Sync',
      '2026-05-23',
      'citation-refresh',
      'alice-example: We agreed to keep launch scoped to citation refresh.',
    );

    const result = await answerCompanyQuestion(engine, {
      question: 'What did we decide?',
    });

    expect(result.source_id).toBe('company');
    expect(result.retrieval_mode).toBe('trusted-workspace-local-direct');
    expect(result.disabled_surfaces).toEqual([...COMPANY_RETRIEVAL_DISABLED_SURFACES]);
    expect(result.decisions).toHaveLength(1);
    expect(result.answer).toContain('Found 1 company decision');
    expect(result.answer).toContain('We agreed to keep launch scoped to citation refresh');
    expect(result.answer).toContain('decision: decisions/2026-05-23-product-sync-we-agreed-to-keep-launch-scoped-to-citation-refresh');
    expect(result.answer).toContain(`source: ${meetingSlug}`);
    expect(result.answer).toContain('evidence: evidence/2026-05-23-transcript-product-sync');

    const hit = result.decisions[0]!;
    expect(hit.decision_date).toBe('2026-05-23');
    expect(hit.projects).toEqual(['citation-refresh']);
    expect(hit.citations.map((c) => c.role)).toEqual(['decision', 'source', 'evidence']);
    expect(hit.citations.map((c) => c.slug)).toEqual([
      'decisions/2026-05-23-product-sync-we-agreed-to-keep-launch-scoped-to-citation-refresh',
      meetingSlug,
      'evidence/2026-05-23-transcript-product-sync',
    ]);
  });

  test('filters decisions by project without reading derived or unsafe surfaces', async () => {
    await ingestAndExtractMeeting(
      'launch-sync.txt',
      'Launch Sync',
      '2026-05-24',
      'citation-refresh',
      'Decision: ship citation rendering before launch.',
    );
    await ingestAndExtractMeeting(
      'ops-sync.txt',
      'Ops Sync',
      '2026-05-24',
      'ops-cleanup',
      'Decision: keep the on-call checklist in the trusted workspace.',
    );

    const result = await answerCompanyQuestion(engine, {
      question: 'What did we decide?',
      project: 'citation-refresh',
    });

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.projects).toEqual(['citation-refresh']);
    expect(result.answer).toContain('ship citation rendering before launch');
    expect(result.answer).not.toContain('on-call checklist');
    expect(result.disabled_surfaces).toContain('query_cache');
    expect(result.disabled_surfaces).toContain('code_intelligence_reads');
    expect(result.disabled_surfaces).toContain('dream_cycle_outputs');
  });

  test('refuses retrieval when company mode is not initialized', async () => {
    await resetPgliteState(engine);

    await expect(answerCompanyQuestion(engine, {
      question: 'What did we decide?',
    })).rejects.toThrow(CompanyRetrieveError);
  });
});
