import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { applyCompanyModeSkeleton } from '../src/core/company-mode.ts';
import { applyCompanyLayout, COMPANY_DEFAULT_POLICY_ID } from '../src/core/company-layout.ts';
import { applyCompanyPolicySeed } from '../src/core/company-policy.ts';
import {
  COMPANY_OBJECT_POLICY_ENFORCEMENT,
  COMPANY_OBJECT_POLICY_STAGE,
} from '../src/core/company-object-policy.ts';
import {
  CompanyIngestError,
  COMPANY_MANUAL_INGEST_KIND,
  ingestCompanyDoc,
  ingestCompanyMeeting,
} from '../src/core/company-ingest.ts';

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
  await applyCompanyPolicySeed(engine);
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-company-ingest-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeFixture(name: string, content: string): string {
  const path = join(tmp, name);
  writeFileSync(path, content, 'utf-8');
  return path;
}

describe('company manual ingestion', () => {
  test('ingests a meeting transcript with linked doc and evidence provenance', async () => {
    const transcript = writeFixture(
      'product-sync.txt',
      'Product sync transcript\n\nAlice: We agreed to keep the launch scoped to search refresh.\nBob: I will send the follow-up.',
    );
    const doc = writeFixture(
      'search-refresh-prd.md',
      '# Search Refresh PRD\n\nThe launch scope is search result quality and citation rendering.',
    );

    const result = await ingestCompanyMeeting(engine, {
      transcriptPath: transcript,
      title: 'Product Sync',
      date: '2026-05-23',
      attendees: ['alice-example', 'bob-example'],
      projects: ['search-refresh'],
      linkedDocs: [{ path: doc, title: 'Search Refresh PRD' }],
      createdBy: 'local-operator',
      noEmbed: true,
      now: new Date('2026-05-23T12:00:00Z'),
    });

    expect(result.source_id).toBe('company');
    expect(result.meeting.slug).toBe('meetings/2026-05-23-product-sync');
    expect(result.docs.map((d) => d.slug)).toEqual(['docs/search-refresh-prd']);
    expect(result.evidence.map((e) => e.slug)).toEqual([
      'evidence/2026-05-23-transcript-product-sync',
      'evidence/2026-05-23-doc-search-refresh-prd',
    ]);

    const meeting = await engine.getPage(result.meeting.slug, { sourceId: 'company' });
    expect(meeting?.type).toBe('meeting');
    expect(meeting?.compiled_truth).toContain('Product sync transcript');
    expect(meeting?.frontmatter.visibility_policy_id).toBe(COMPANY_DEFAULT_POLICY_ID);
    expect(meeting?.frontmatter.visibility_policy_ids).toEqual([COMPANY_DEFAULT_POLICY_ID]);
    expect(meeting?.frontmatter.object_policy_metadata_stage).toBe(COMPANY_OBJECT_POLICY_STAGE);
    expect(meeting?.frontmatter.object_policy_enforcement).toBe(COMPANY_OBJECT_POLICY_ENFORCEMENT);
    expect(meeting?.frontmatter.visibility_assignment).toBe('path_default');
    expect(meeting?.frontmatter.visibility_assignment_reason).toBe('policy_storage_path_default');
    expect(meeting?.frontmatter.created_by).toBe('local-operator');
    expect(meeting?.frontmatter.event_date).toBe('2026-05-23');
    expect(meeting?.frontmatter.attendees).toEqual(['alice-example', 'bob-example']);
    expect(meeting?.frontmatter.projects).toEqual(['search-refresh']);
    expect(meeting?.frontmatter.linked_docs).toEqual(['docs/search-refresh-prd']);
    expect(meeting?.frontmatter.evidence_refs).toEqual(['evidence/2026-05-23-transcript-product-sync']);
    expect(meeting?.frontmatter.derived_from).toEqual(['evidence/2026-05-23-transcript-product-sync']);
    expect(meeting?.frontmatter.policy_enforcement).toBe('deferred');
    expect(meeting?.source_kind).toBe(COMPANY_MANUAL_INGEST_KIND);
    expect(meeting?.source_uri).toMatch(/^file:\/\//);
    expect(meeting?.ingested_via).toBe('company-manual:meeting-transcript');

    const linkedDoc = await engine.getPage('docs/search-refresh-prd', { sourceId: 'company' });
    expect(linkedDoc?.type).toBe('doc');
    expect(linkedDoc?.frontmatter.visibility_policy_id).toBe(COMPANY_DEFAULT_POLICY_ID);
    expect(linkedDoc?.frontmatter.object_policy_metadata_stage).toBe(COMPANY_OBJECT_POLICY_STAGE);
    expect(linkedDoc?.frontmatter.linked_meetings).toEqual(['meetings/2026-05-23-product-sync']);
    expect(linkedDoc?.frontmatter.evidence_refs).toEqual(['evidence/2026-05-23-doc-search-refresh-prd']);
    expect(linkedDoc?.compiled_truth).toContain('Search Refresh PRD');
    expect(linkedDoc?.ingested_via).toBe('company-manual:linked-doc');

    const evidence = await engine.getPage('evidence/2026-05-23-transcript-product-sync', { sourceId: 'company' });
    const expectedHash = createHash('sha256').update(readFileSync(transcript)).digest('hex');
    expect(evidence?.type).toBe('evidence');
    expect(evidence?.frontmatter.visibility_policy_id).toBe(COMPANY_DEFAULT_POLICY_ID);
    expect(evidence?.frontmatter.object_policy_metadata_stage).toBe(COMPANY_OBJECT_POLICY_STAGE);
    expect(evidence?.frontmatter.evidence_type).toBe('transcript');
    expect(evidence?.frontmatter.supports).toEqual(['meetings/2026-05-23-product-sync']);
    expect(evidence?.frontmatter.source_sha256).toBe(expectedHash);
    expect(evidence?.compiled_truth).toContain('SHA-256:');
    expect(evidence?.ingested_via).toBe('company-manual:evidence');
  });

  test('ingests a standalone linked document with an evidence page', async () => {
    const doc = writeFixture(
      'planning-note.md',
      '# Planning Note\n\nThe operating memo says the trusted pilot is local only.',
    );

    const result = await ingestCompanyDoc(engine, {
      docPath: doc,
      date: '2026-05-24',
      projects: ['company-memory'],
      noEmbed: true,
      now: new Date('2026-05-24T09:30:00Z'),
    });

    expect(result.doc.slug).toBe('docs/planning-note');
    expect(result.evidence.slug).toBe('evidence/2026-05-24-doc-planning-note');

    const page = await engine.getPage(result.doc.slug, { sourceId: 'company' });
    expect(page?.frontmatter.visibility_policy_id).toBe(COMPANY_DEFAULT_POLICY_ID);
    expect(page?.frontmatter.projects).toEqual(['company-memory']);
    expect(page?.frontmatter.evidence_refs).toEqual([result.evidence.slug]);
    expect(page?.source_kind).toBe(COMPANY_MANUAL_INGEST_KIND);
  });

  test('refuses ingestion when company mode is not initialized', async () => {
    await resetPgliteState(engine);
    const doc = writeFixture('plain.md', '# Plain');

    await expect(ingestCompanyDoc(engine, {
      docPath: doc,
      noEmbed: true,
    })).rejects.toThrow(CompanyIngestError);
  });

  test('rejects binary files before writing pages', async () => {
    const binary = join(tmp, 'transcript.txt');
    writeFileSync(binary, Buffer.from([0x23, 0x20, 0x00, 0x01]));

    await expect(ingestCompanyMeeting(engine, {
      transcriptPath: binary,
      noEmbed: true,
    })).rejects.toThrow(/binary/);
  });

  test('rejects non-text extensions before writing pages', async () => {
    const pdfLike = writeFixture(
      'meeting.pdf',
      '%PDF-1.7\nThis fixture is ASCII and NUL-free but still not a Stage 1C text input.',
    );

    await expect(ingestCompanyMeeting(engine, {
      transcriptPath: pdfLike,
      noEmbed: true,
    })).rejects.toThrow(/text\/markdown file/);

    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = 'company'`,
    );
    expect(rows[0]?.n).toBe(0);
  });
});
