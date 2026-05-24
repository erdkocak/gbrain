import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AuthInfo } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { applyCompanyModeSkeleton } from '../src/core/company-mode.ts';
import { applyCompanyLayout } from '../src/core/company-layout.ts';
import { applyCompanyPolicySeed, parseCompanyPolicySeedYaml } from '../src/core/company-policy.ts';
import { dispatchToolCall, type ToolResult } from '../src/mcp/dispatch.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

const VISIBLE_SLUG = 'people/alice-visible';
const SECRET_SLUG = 'people/bob-secret';

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
  await initCompanyBrain();
  await seedPolicySeparatedRows();
});

function companySeed() {
  return parseCompanyPolicySeedYaml(`
version: 1
users:
  - id: company-admin
    email: admin@example.invalid
    idp_subjects:
      - oauth-client:gbrain_cl_admin
  - id: company-alice
    email: alice@example.invalid
    idp_subjects:
      - oauth-client:gbrain_cl_alice
      - client-name:alice-agent
  - id: company-bob
    email: bob@example.invalid
    idp_subjects:
      - oauth-client:gbrain_cl_bob
      - client-name:bob-agent
groups:
  - id: company-pilot-admins
    members:
      - company-admin
  - id: engineering
    members:
      - company-alice
  - id: sales
    members:
      - company-bob
policies:
  - id: company-trusted-workspace
    read:
      groups:
        - company-pilot-admins
    write:
      groups:
        - company-pilot-admins
  - id: engineering-notes
    read:
      groups:
        - engineering
    write:
      groups:
        - engineering
  - id: sales-notes
    read:
      groups:
        - sales
    write:
      groups:
        - sales
path_defaults:
  - object_type: meeting
    path_prefix: meetings/
    visibility_policy_id: engineering-notes
audit:
  readers:
    groups:
      - company-pilot-admins
`);
}

async function initCompanyBrain(): Promise<void> {
  await applyCompanyModeSkeleton(engine);
  await applyCompanyLayout(engine);
  await applyCompanyPolicySeed(engine, companySeed());
}

function hostedAuth(client: 'alice' | 'bob'): AuthInfo {
  return {
    token: `gbrain_at_${client}`,
    clientId: client === 'alice' ? 'gbrain_cl_alice' : 'gbrain_cl_bob',
    clientName: `${client}-agent`,
    scopes: ['read', 'write'],
    sourceId: 'company',
    allowedSources: ['company'],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

async function seedPolicySeparatedRows(): Promise<void> {
  const visible = await engine.putPage(VISIBLE_SLUG, {
    type: 'person',
    title: 'Engineering Visible',
    compiled_truth: 'visible engineering body',
    timeline: '',
    frontmatter: {
      visibility_policy_id: 'engineering-notes',
      visibility_policy_ids: ['engineering-notes'],
    },
  }, { sourceId: 'company' });

  const secret = await engine.putPage(SECRET_SLUG, {
    type: 'person',
    title: 'Sales Secret',
    compiled_truth: 'secret sales body',
    timeline: '',
    frontmatter: {
      visibility_policy_id: 'sales-notes',
      visibility_policy_ids: ['sales-notes'],
    },
  }, { sourceId: 'company' });

  await engine.upsertChunks(VISIBLE_SLUG, [{
    chunk_index: 0,
    chunk_text: 'visible engineering chunk',
    chunk_source: 'compiled_truth',
  }], { sourceId: 'company' });
  await engine.upsertChunks(SECRET_SLUG, [{
    chunk_index: 0,
    chunk_text: 'secret sales chunk',
    chunk_source: 'compiled_truth',
  }], { sourceId: 'company' });

  await engine.createVersion(VISIBLE_SLUG, { sourceId: 'company' });
  await engine.createVersion(SECRET_SLUG, { sourceId: 'company' });

  await engine.addTimelineEntry(VISIBLE_SLUG, {
    date: '2026-01-01',
    source: 'fixture',
    summary: 'Visible engineering event',
    detail: 'Visible detail',
  }, { sourceId: 'company' });
  await engine.addTimelineEntry(SECRET_SLUG, {
    date: '2026-01-02',
    source: 'fixture',
    summary: 'Secret sales event',
    detail: 'Secret detail',
  }, { sourceId: 'company' });

  await engine.putRawData(VISIBLE_SLUG, 'fixture', { note: 'visible raw' }, { sourceId: 'company' });
  await engine.putRawData(SECRET_SLUG, 'fixture', { note: 'secret raw' }, { sourceId: 'company' });

  await engine.addTakesBatch([
    {
      page_id: visible.id,
      row_num: 1,
      claim: 'visible engineering take',
      kind: 'take',
      holder: 'world',
      weight: 0.6,
      source: 'fixture',
    },
    {
      page_id: secret.id,
      row_num: 1,
      claim: 'secret sales take',
      kind: 'take',
      holder: 'world',
      weight: 0.6,
      source: 'fixture',
    },
  ]);

  await engine.insertFacts([
    {
      row_num: 1,
      source_markdown_slug: VISIBLE_SLUG,
      entity_slug: VISIBLE_SLUG,
      fact: 'visible engineering fact',
      kind: 'fact',
      visibility: 'world',
      notability: 'medium',
      source: 'fixture',
      confidence: 1,
      claim_metric: 'team_size',
      claim_value: 12,
      claim_unit: 'people',
      claim_period: null,
      valid_from: new Date('2026-01-01T00:00:00Z'),
    },
    {
      row_num: 1,
      source_markdown_slug: SECRET_SLUG,
      entity_slug: SECRET_SLUG,
      fact: 'secret sales fact',
      kind: 'fact',
      visibility: 'world',
      notability: 'medium',
      source: 'fixture',
      confidence: 1,
      claim_metric: 'team_size',
      claim_value: 8,
      claim_unit: 'people',
      claim_period: null,
      valid_from: new Date('2026-01-01T00:00:00Z'),
    },
  ], { source_id: 'company' });
}

async function callAs(client: 'alice' | 'bob', name: string, params: Record<string, unknown> = {}) {
  return dispatchToolCall(engine, name, params, {
    remote: true,
    sourceId: 'company',
    auth: hostedAuth(client),
  });
}

function parseToolJson(result: ToolResult): any {
  return JSON.parse(result.content[0]!.text);
}

describe('company direct read filters', () => {
  test('separates page, chunk, history, raw, timeline, and take reads by readable policy', async () => {
    const visiblePage = await callAs('alice', 'get_page', { slug: VISIBLE_SLUG });
    expect(visiblePage.isError).toBeUndefined();
    expect(parseToolJson(visiblePage).compiled_truth).toContain('visible engineering body');

    const secretPage = await callAs('alice', 'get_page', { slug: SECRET_SLUG });
    expect(secretPage.isError).toBe(true);
    expect(parseToolJson(secretPage)).toMatchObject({ error: 'page_not_found' });

    const listed = parseToolJson(await callAs('alice', 'list_pages'));
    expect(listed.map((row: { slug: string }) => row.slug)).toContain(VISIBLE_SLUG);
    expect(listed.map((row: { slug: string }) => row.slug)).not.toContain(SECRET_SLUG);

    expect(parseToolJson(await callAs('alice', 'get_chunks', { slug: VISIBLE_SLUG }))
      .map((row: { chunk_text: string }) => row.chunk_text)).toEqual(['visible engineering chunk']);
    expect(parseToolJson(await callAs('alice', 'get_chunks', { slug: SECRET_SLUG }))).toEqual([]);

    expect(parseToolJson(await callAs('alice', 'get_versions', { slug: VISIBLE_SLUG }))).toHaveLength(1);
    expect(parseToolJson(await callAs('alice', 'get_versions', { slug: SECRET_SLUG }))).toEqual([]);

    expect(parseToolJson(await callAs('alice', 'get_timeline', { slug: VISIBLE_SLUG }))
      .map((row: { summary: string }) => row.summary)).toEqual(['Visible engineering event']);
    expect(parseToolJson(await callAs('alice', 'get_timeline', { slug: SECRET_SLUG }))).toEqual([]);

    expect(parseToolJson(await callAs('alice', 'get_raw_data', { slug: VISIBLE_SLUG }))
      .map((row: { data: { note: string } }) => row.data.note)).toEqual(['visible raw']);
    expect(parseToolJson(await callAs('alice', 'get_raw_data', { slug: SECRET_SLUG }))).toEqual([]);

    const takes = parseToolJson(await callAs('alice', 'takes_list'));
    expect(takes.map((row: { claim: string }) => row.claim)).toEqual(['visible engineering take']);

    const fileList = await callAs('alice', 'file_list', { slug: VISIBLE_SLUG });
    expect(fileList.isError).toBe(true);
    expect(parseToolJson(fileList)).toMatchObject({ error: 'permission_denied' });

    const fileUrl = await callAs('alice', 'file_url', { storage_path: `${VISIBLE_SLUG}/deck.pdf` });
    expect(fileUrl.isError).toBe(true);
    expect(parseToolJson(fileUrl)).toMatchObject({ error: 'permission_denied' });

    const bobList = parseToolJson(await callAs('bob', 'list_pages'));
    expect(bobList.map((row: { slug: string }) => row.slug)).toContain(SECRET_SLUG);
    expect(bobList.map((row: { slug: string }) => row.slug)).not.toContain(VISIBLE_SLUG);
  });

  test('separates facts, trajectories, and fuzzy slug candidates by readable policy', async () => {
    const recall = parseToolJson(await callAs('alice', 'recall'));
    expect(recall.facts.map((row: { fact: string }) => row.fact)).toEqual(['visible engineering fact']);
    expect(recall.pending_consolidation_count).toBeUndefined();

    const visibleTrajectory = parseToolJson(await callAs('alice', 'find_trajectory', {
      entity_slug: VISIBLE_SLUG,
      metric: 'team_size',
    }));
    expect(visibleTrajectory.points.map((row: { text: string }) => row.text)).toEqual(['visible engineering fact']);

    const secretTrajectory = parseToolJson(await callAs('alice', 'find_trajectory', {
      entity_slug: SECRET_SLUG,
      metric: 'team_size',
    }));
    expect(secretTrajectory.points).toEqual([]);

    expect(parseToolJson(await callAs('alice', 'resolve_slugs', { partial: 'bob-secret' }))).toEqual([]);
    expect(parseToolJson(await callAs('bob', 'recall')).facts.map((row: { fact: string }) => row.fact))
      .toEqual(['secret sales fact']);
  });

  test('filters ingest log rows without exposing hidden or mixed page updates', async () => {
    await engine.logIngest({
      source_id: 'company',
      source_type: 'meeting',
      source_ref: 'visible-source-ref',
      pages_updated: [VISIBLE_SLUG],
      summary: 'visible ingest summary',
    });
    await engine.logIngest({
      source_id: 'company',
      source_type: 'meeting',
      source_ref: 'secret-source-ref',
      pages_updated: [SECRET_SLUG],
      summary: 'secret ingest summary',
    });
    await engine.logIngest({
      source_id: 'company',
      source_type: 'meeting',
      source_ref: 'mixed-source-ref',
      pages_updated: [VISIBLE_SLUG, SECRET_SLUG],
      summary: 'mixed ingest summary',
    });

    const aliceLog = parseToolJson(await callAs('alice', 'get_ingest_log', { limit: 10 }));
    expect(aliceLog.map((row: { source_ref: string }) => row.source_ref)).toEqual(['visible-source-ref']);
    expect(aliceLog[0].pages_updated).toEqual([VISIBLE_SLUG]);

    const bobLog = parseToolJson(await callAs('bob', 'get_ingest_log', { limit: 10 }));
    expect(bobLog.map((row: { source_ref: string }) => row.source_ref)).toEqual(['secret-source-ref']);
    expect(bobLog[0].pages_updated).toEqual([SECRET_SLUG]);
  });

  test('keeps private superseded facts out of hosted recall supersessions', async () => {
    const inserted = await engine.insertFacts([
      {
        row_num: 2,
        source_markdown_slug: VISIBLE_SLUG,
        entity_slug: VISIBLE_SLUG,
        fact: 'private superseded engineering fact',
        kind: 'fact',
        visibility: 'private',
        notability: 'medium',
        source: 'fixture',
        confidence: 1,
        valid_from: new Date('2026-01-02T00:00:00Z'),
      },
      {
        row_num: 3,
        source_markdown_slug: VISIBLE_SLUG,
        entity_slug: VISIBLE_SLUG,
        fact: 'world superseded engineering fact',
        kind: 'fact',
        visibility: 'world',
        notability: 'medium',
        source: 'fixture',
        confidence: 1,
        valid_from: new Date('2026-01-03T00:00:00Z'),
      },
    ], { source_id: 'company' });
    for (const id of inserted.ids) {
      await engine.executeRaw(
        `UPDATE facts SET expired_at = now(), superseded_by = $1 WHERE id = $1`,
        [id],
      );
    }

    const hosted = parseToolJson(await callAs('alice', 'recall', { supersessions: true, limit: 10 }));
    expect(hosted.facts.map((row: { fact: string }) => row.fact)).toEqual(['world superseded engineering fact']);

    const local = await dispatchToolCall(engine, 'recall', { supersessions: true, limit: 10 }, {
      remote: false,
      sourceId: 'company',
    });
    expect(parseToolJson(local).facts.map((row: { fact: string }) => row.fact)).toEqual([
      'world superseded engineering fact',
      'private superseded engineering fact',
    ]);
  });
});
