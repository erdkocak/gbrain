import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { applyCompanyModeSkeleton } from '../src/core/company-mode.ts';
import { applyCompanyLayout, COMPANY_DEFAULT_POLICY_ID } from '../src/core/company-layout.ts';
import { ingestCompanyDoc, ingestCompanyMeeting } from '../src/core/company-ingest.ts';
import {
  CompanyExtractError,
  COMPANY_EXTRACTION_KIND,
  extractCompanyMemory,
} from '../src/core/company-extract.ts';

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
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-company-extract-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeFixture(name: string, content: string): string {
  const path = join(tmp, name);
  writeFileSync(path, content, 'utf-8');
  return path;
}

describe('company extraction', () => {
  test('extracts decisions, commitments, actions, owners, and evidence refs from a meeting', async () => {
    const transcript = writeFixture(
      'product-sync.txt',
      [
        'Product sync transcript',
        '',
        'alice-example: We agreed to keep launch scoped to citation refresh.',
        'bob-example: I will send the follow-up summary.',
      ].join('\n'),
    );

    const ingest = await ingestCompanyMeeting(engine, {
      transcriptPath: transcript,
      title: 'Product Sync',
      date: '2026-05-23',
      attendees: ['alice-example', 'bob-example'],
      projects: ['citation-refresh'],
      createdBy: 'local-operator',
      noEmbed: true,
      now: new Date('2026-05-23T12:00:00Z'),
    });

    const result = await extractCompanyMemory(engine, {
      slugs: [ingest.meeting.slug],
      createdBy: 'extract-operator',
      noEmbed: true,
      now: new Date('2026-05-23T13:00:00Z'),
    });

    expect(result.source_id).toBe('company');
    expect(result.inputs).toEqual([ingest.meeting.slug]);
    expect(result.decisions).toHaveLength(1);
    expect(result.commitments).toHaveLength(1);
    expect(result.actions).toHaveLength(1);
    expect(result.skipped).toEqual([]);

    const decisionSlug = 'decisions/2026-05-23-product-sync-we-agreed-to-keep-launch-scoped-to-citation-refresh';
    expect(result.decisions[0]?.slug).toBe(decisionSlug);
    const decision = await engine.getPage(decisionSlug, { sourceId: 'company' });
    expect(decision?.type).toBe('decision');
    expect(decision?.frontmatter.visibility_policy_id).toBe(COMPANY_DEFAULT_POLICY_ID);
    expect(decision?.frontmatter.created_by).toBe('extract-operator');
    expect(decision?.frontmatter.derived_from).toEqual([ingest.meeting.slug]);
    expect(decision?.frontmatter.evidence_refs).toEqual([ingest.evidence[0]?.slug]);
    expect(decision?.frontmatter.decision_date).toBe('2026-05-23');
    expect(decision?.frontmatter.status).toBe('accepted');
    expect(decision?.frontmatter.policy_enforcement).toBe('deferred');
    expect(decision?.frontmatter.trusted_workspace_artifact).toBe(true);
    expect(decision?.frontmatter.extraction_stage).toBe('stage-1d-local');
    expect(decision?.compiled_truth).toContain('We agreed to keep launch scoped to citation refresh');
    expect(decision?.compiled_truth).toContain(`[[${ingest.evidence[0]?.slug}]]`);
    expect(decision?.source_kind).toBe(COMPANY_EXTRACTION_KIND);
    expect(decision?.source_uri).toBe(`gbrain://company/company/${ingest.meeting.slug}`);
    expect(decision?.ingested_via).toBe('company-extract:decision');

    const commitment = await engine.getPage(result.commitments[0]!.slug, { sourceId: 'company' });
    expect(commitment?.type).toBe('commitment');
    expect(commitment?.frontmatter.owner).toBe('bob-example');
    expect(commitment?.frontmatter.projects).toEqual(['citation-refresh']);
    expect(commitment?.frontmatter.source_meeting).toBe(ingest.meeting.slug);
    expect(commitment?.frontmatter.evidence_refs).toEqual([ingest.evidence[0]?.slug]);
    expect(commitment?.ingested_via).toBe('company-extract:commitment');

    const action = await engine.getPage(result.actions[0]!.slug, { sourceId: 'company' });
    expect(action?.type).toBe('action');
    expect(action?.frontmatter.owner).toBe('bob-example');
    expect(action?.frontmatter.status).toBe('open');
    expect(action?.frontmatter.source_meeting).toBe(ingest.meeting.slug);
    expect(action?.compiled_truth).toContain('Candidate follow-up');
    expect(action?.ingested_via).toBe('company-extract:action');
  });

  test('extract all scans meeting and doc pages but not derived pages', async () => {
    const transcript = writeFixture(
      'planning-sync.md',
      '# Planning Sync\n\nDecision: keep the trusted pilot local.',
    );
    const doc = writeFixture(
      'operating-note.md',
      '# Operating Note\n\nAction: owner: casey-example update the pilot checklist.',
    );

    const meeting = await ingestCompanyMeeting(engine, {
      transcriptPath: transcript,
      date: '2026-05-24',
      noEmbed: true,
      now: new Date('2026-05-24T10:00:00Z'),
    });
    const document = await ingestCompanyDoc(engine, {
      docPath: doc,
      date: '2026-05-24',
      noEmbed: true,
      now: new Date('2026-05-24T10:00:00Z'),
    });

    const first = await extractCompanyMemory(engine, {
      noEmbed: true,
      now: new Date('2026-05-24T11:00:00Z'),
    });
    expect(first.inputs.sort()).toEqual([document.doc.slug, meeting.meeting.slug].sort());
    expect(first.decisions).toHaveLength(1);
    expect(first.actions).toHaveLength(1);
    expect(first.actions[0]?.owner).toBe('casey-example');

    const second = await extractCompanyMemory(engine, {
      noEmbed: true,
      now: new Date('2026-05-24T11:00:00Z'),
    });
    expect(second.inputs.sort()).toEqual([document.doc.slug, meeting.meeting.slug].sort());
    expect(second.decisions).toHaveLength(1);
    expect(second.actions).toHaveLength(1);
    expect(second.skipped.some((s) => s.slug.startsWith('decisions/'))).toBe(false);
  });

  test('refuses extraction when company mode is not initialized', async () => {
    await resetPgliteState(engine);

    await expect(extractCompanyMemory(engine, {
      slugs: ['meetings/2026-05-23-product-sync'],
      noEmbed: true,
    })).rejects.toThrow(CompanyExtractError);
  });
});
