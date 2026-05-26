import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AuthInfo } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { applyCompanyModeSkeleton } from '../src/core/company-mode.ts';
import { applyCompanyLayout } from '../src/core/company-layout.ts';
import { applyCompanyPolicySeed, parseCompanyPolicySeedYaml } from '../src/core/company-policy.ts';
import {
  appendCompanyAuditEvent,
  appendCompanyAuditEventInTransaction,
  type CompanyAuditEventInput,
} from '../src/core/company-audit.ts';
import { verifyCompanyAuditHashChain } from '../src/core/company-audit-read.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { dispatchToolCall, listVisibleOperationsForDispatch, type ToolResult } from '../src/mcp/dispatch.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const ENG_POLICY = 'engineering-notes';
const SALES_POLICY = 'sales-notes';
const VISIBLE_SLUG = 'docs/engineering/audit-matrix-visible';
const PEER_SLUG = 'docs/engineering/audit-matrix-peer';
const HIDDEN_SLUG = 'docs/sales/audit-matrix-hidden';
const WRITE_SLUG = 'docs/engineering/audit-matrix-write';
const DERIVED_SLUG = 'decisions/audit-matrix-derived';
const QUERY = 'auditmatrixneedle';

let engine: PGLiteEngine;

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
  await seedRows();
});

function companySeed() {
  return parseCompanyPolicySeedYaml(`
version: 1
users:
  - id: company-eng-user
    email: eng@example.invalid
    idp_subjects:
      - oauth-client:gbrain_cl_eng
      - client-name:eng-agent
groups:
  - id: engineering
    members:
      - company-eng-user
policies:
  - id: company-trusted-workspace
    read:
      groups:
        - engineering
    write:
      groups:
        - engineering
  - id: engineering-notes
    read:
      groups:
        - engineering
    write:
      groups:
        - engineering
  - id: sales-notes
    read:
      users: []
    write:
      users: []
path_defaults:
  - object_type: doc
    path_prefix: docs/engineering/
    visibility_policy_id: engineering-notes
  - object_type: doc
    path_prefix: docs/sales/
    visibility_policy_id: sales-notes
  - object_type: decision
    path_prefix: decisions/
    visibility_policy_id: engineering-notes
audit:
  readers:
    groups:
      - engineering
`);
}

async function initCompanyBrain(): Promise<void> {
  await applyCompanyModeSkeleton(engine);
  await applyCompanyLayout(engine);
  await applyCompanyPolicySeed(engine, companySeed());
}

async function seedRows(): Promise<void> {
  await seedPage(VISIBLE_SLUG, ENG_POLICY, `${QUERY} visible engineering body`);
  await seedPage(PEER_SLUG, ENG_POLICY, 'visible graph peer body');
  await seedPage(HIDDEN_SLUG, SALES_POLICY, `${QUERY} hidden sales body`);
  await engine.addLink(VISIBLE_SLUG, PEER_SLUG, 'visible graph relation', 'mentions', undefined, undefined, undefined, {
    fromSourceId: 'company',
    toSourceId: 'company',
    originSourceId: 'company',
  });
  await engine.addLink(VISIBLE_SLUG, HIDDEN_SLUG, 'hidden graph relation', 'mentions', undefined, undefined, undefined, {
    fromSourceId: 'company',
    toSourceId: 'company',
    originSourceId: 'company',
  });
}

async function seedPage(slug: string, policyId: string, body: string): Promise<void> {
  await engine.putPage(slug, {
    type: 'doc',
    title: slug,
    compiled_truth: body,
    timeline: '',
    frontmatter: {
      visibility_policy_id: policyId,
      visibility_policy_ids: [policyId],
    },
  }, { sourceId: 'company' });
  await engine.upsertChunks(slug, [{
    chunk_index: 0,
    chunk_text: body,
    chunk_source: 'compiled_truth',
    modality: 'text',
  }], { sourceId: 'company' });
}

function hostedAuth(): AuthInfo {
  return {
    token: 'gbrain_at_eng',
    clientId: 'gbrain_cl_eng',
    clientName: 'eng-agent',
    scopes: ['read', 'write'],
    sourceId: 'company',
    allowedSources: ['company'],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

async function call(name: string, params: Record<string, unknown>, requestId: string): Promise<ToolResult> {
  return dispatchToolCall(engine, name, params, {
    remote: true,
    sourceId: 'company',
    auth: hostedAuth(),
    requestId,
  });
}

function markdown(type: string, title: string, frontmatter: Record<string, unknown> = {}, body = 'Body'): string {
  return serializeMarkdown(frontmatter, body, '', { type, title, tags: [] });
}

async function auditRows(): Promise<any[]> {
  return engine.executeRaw(
    `SELECT sequence_id, event_type, request_id, operation, content_or_query_hash,
            result_count, object_ids_or_slugs, status, denial_reason
       FROM company_audit_events
      ORDER BY sequence_id`,
  );
}

function jsonColumn<T>(value: unknown): T {
  return typeof value === 'string' ? JSON.parse(value) as T : value as T;
}

function rowsFor(rows: any[], requestId: string, eventType?: string): any[] {
  return rows.filter((row) => row.request_id === requestId && (!eventType || row.event_type === eventType));
}

function parseToolJson<T = any>(result: ToolResult): T {
  return JSON.parse(result.content[0]!.text) as T;
}

function appendAuditFromProvidedEngine(...args: Parameters<typeof appendCompanyAuditEvent>) {
  const [auditEngine, input, opts] = args;
  const db = (auditEngine as unknown as { db?: { transaction?: unknown } }).db;
  return typeof db?.transaction === 'function'
    ? appendCompanyAuditEvent(auditEngine, input, opts)
    : appendCompanyAuditEventInTransaction(auditEngine, input, opts);
}

describe('company hosted audit claim gate', () => {
  test('records the hosted audit matrix without hidden objects or raw payloads', async () => {
    const listed = await listVisibleOperationsForDispatch(engine, {
      remote: true,
      sourceId: 'company',
      auth: hostedAuth(),
      requestId: 'req-matrix-tool-list',
    });
    expect(listed.map((op) => op.name)).toContain('get_page');

    const directRead = await call('get_page', { slug: VISIBLE_SLUG }, 'req-matrix-direct-read');
    expect(directRead.isError).toBeUndefined();
    expect(parseToolJson(directRead).slug).toBe(VISIBLE_SLUG);

    const retrieval = await call('search', { query: QUERY, limit: 10 }, 'req-matrix-retrieval');
    expect(retrieval.isError).toBeUndefined();
    expect(parseToolJson<Array<{ slug: string }>>(retrieval).map((row) => row.slug)).toContain(VISIBLE_SLUG);

    const graph = await call('get_links', { slug: VISIBLE_SLUG }, 'req-matrix-graph');
    expect(graph.isError).toBeUndefined();
    expect(parseToolJson<Array<{ to_slug: string }>>(graph).map((row) => row.to_slug)).toEqual([PEER_SLUG]);

    const code = await call('code_refs', { symbol: 'NoSuchMatrixSymbol', limit: 5 }, 'req-matrix-code');
    expect(code.isError).toBeUndefined();
    expect(parseToolJson<{ count: number }>(code).count).toBe(0);

    const denied = await call('get_health', {}, 'req-matrix-denied-tool');
    expect(denied.isError).toBe(true);

    const write = await call('put_page', {
      slug: WRITE_SLUG,
      content: markdown('doc', 'Audit Matrix Write', {}, 'Matrix write body should only be hashed.'),
    }, 'req-matrix-write');
    expect(write.isError).toBeUndefined();

    const derived = await call('put_page', {
      slug: DERIVED_SLUG,
      content: markdown('decision', 'Audit Matrix Derived', {
        derived_from: [VISIBLE_SLUG],
      }, 'Matrix derived body should only be hashed.'),
    }, 'req-matrix-derived');
    expect(derived.isError).toBeUndefined();

    const metadataRaw = await engine.getConfig('company.policy.metadata');
    const metadata = JSON.parse(metadataRaw!);
    metadata.policy_hash = '0'.repeat(64);
    await engine.setConfig('company.policy.metadata', JSON.stringify(metadata));
    const stale = await call('whoami', {}, 'req-matrix-stale-policy');
    expect(stale.isError).toBe(true);

    const rows = await auditRows();
    expect(rowsFor(rows, 'req-matrix-tool-list', 'company.hosted.tool_list')).toHaveLength(1);
    expect(rowsFor(rows, 'req-matrix-direct-read', 'company.hosted.tool_call').map((row) => row.status)).toEqual(['attempted', 'succeeded']);
    expect(rowsFor(rows, 'req-matrix-direct-read', 'company.hosted.read_result')).toHaveLength(1);
    expect(rowsFor(rows, 'req-matrix-retrieval', 'company.hosted.read_result')).toHaveLength(1);
    expect(rowsFor(rows, 'req-matrix-graph', 'company.hosted.read_result')).toHaveLength(1);
    expect(rowsFor(rows, 'req-matrix-code', 'company.hosted.read_result')).toHaveLength(1);
    expect(rowsFor(rows, 'req-matrix-denied-tool', 'company.hosted.denial')).toHaveLength(1);
    expect(rowsFor(rows, 'req-matrix-write', 'company.hosted.write_result').map((row) => row.status)).toEqual(['attempted', 'succeeded']);
    expect(rowsFor(rows, 'req-matrix-derived', 'company.hosted.derived_write').map((row) => row.status)).toEqual(['succeeded']);
    expect(rowsFor(rows, 'req-matrix-stale-policy', 'company.hosted.denial')[0]).toMatchObject({
      status: 'denied',
      denial_reason: 'request_gate_missing_policy_context',
    });

    const retrievalAudit = rowsFor(rows, 'req-matrix-retrieval', 'company.hosted.read_result')[0]!;
    const retrievalRefs = jsonColumn<Array<string | number>>(retrievalAudit.object_ids_or_slugs);
    expect(retrievalRefs).toContain(VISIBLE_SLUG);
    expect(retrievalRefs).not.toContain(HIDDEN_SLUG);
    expect(retrievalAudit.content_or_query_hash).toMatch(/^[0-9a-f]{64}$/);

    const graphAudit = rowsFor(rows, 'req-matrix-graph', 'company.hosted.read_result')[0]!;
    const graphRefs = jsonColumn<Array<string | number>>(graphAudit.object_ids_or_slugs);
    expect(graphRefs).toContain(VISIBLE_SLUG);
    expect(graphRefs).toContain(PEER_SLUG);
    expect(graphRefs).not.toContain(HIDDEN_SLUG);

    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(QUERY);
    expect(serialized).not.toContain('hidden sales body');
    expect(serialized).not.toContain('hidden graph relation');
    expect(serialized).not.toContain('Matrix write body should only be hashed');
    expect(serialized).not.toContain('Matrix derived body should only be hashed');

    const chain = await verifyCompanyAuditHashChain(engine);
    expect(chain.valid).toBe(true);
    expect(chain.issues).toEqual([]);
  });

  test('fails closed when required hosted audit appends fail', async () => {
    const failingAuditAppend = async () => {
      throw new Error('audit unavailable');
    };

    const listed = await listVisibleOperationsForDispatch(engine, {
      remote: true,
      sourceId: 'company',
      auth: hostedAuth(),
      requestId: 'req-matrix-list-audit-down',
      companyAuditAppend: failingAuditAppend,
    });
    expect(listed).toEqual([]);

    const read = await dispatchToolCall(engine, 'get_page', { slug: VISIBLE_SLUG }, {
      remote: true,
      sourceId: 'company',
      auth: hostedAuth(),
      requestId: 'req-matrix-read-audit-down',
      companyAuditAppend: failingAuditAppend,
    });
    expect(read.isError).toBe(true);
    expect(parseToolJson(read)).toMatchObject({
      error: 'permission_denied',
      message: 'Company audit append failed for hosted company request.',
    });
    expect(read.content[0]!.text).not.toContain('visible engineering body');

    const target = 'docs/engineering/audit-matrix-write-audit-down';
    const write = await dispatchToolCall(engine, 'put_page', {
      slug: target,
      content: markdown('doc', 'Write Audit Down', {}, 'Write failure body should not commit.'),
    }, {
      remote: true,
      sourceId: 'company',
      auth: hostedAuth(),
      requestId: 'req-matrix-write-audit-down',
      companyAuditAppend: async (...args: Parameters<typeof appendCompanyAuditEvent>) => {
        const event = args[1] as CompanyAuditEventInput;
        if (event.event_type === 'company.hosted.write_result' && event.status === 'succeeded') {
          throw new Error('write success audit unavailable');
        }
        return appendAuditFromProvidedEngine(...args);
      },
    });
    expect(write.isError).toBe(true);
    expect(parseToolJson(write)).toMatchObject({
      error: 'permission_denied',
      message: 'Company audit append failed for hosted company request.',
    });
    expect(await engine.getPage(target, { sourceId: 'company' })).toBeNull();

    const support = await dispatchToolCall(engine, 'whoami', {}, {
      remote: true,
      sourceId: 'company',
      auth: hostedAuth(),
      requestId: 'req-matrix-support-audit-down',
      companyAuditAppend: failingAuditAppend,
    });
    expect(support.isError).toBeUndefined();
    expect(parseToolJson(support).transport).toBe('oauth');
  });
});
