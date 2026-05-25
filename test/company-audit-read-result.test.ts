import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AuthInfo } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { applyCompanyModeSkeleton } from '../src/core/company-mode.ts';
import { applyCompanyLayout } from '../src/core/company-layout.ts';
import { applyCompanyPolicySeed, parseCompanyPolicySeedYaml } from '../src/core/company-policy.ts';
import { appendCompanyAuditEvent, hashCompanyAuditValue } from '../src/core/company-audit.ts';
import { dispatchToolCall, type ToolResult } from '../src/mcp/dispatch.ts';
import { buildHostedCompanyReadResultAudit } from '../src/mcp/company-read-audit.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const ENG_POLICY = 'engineering-notes';
const SALES_POLICY = 'sales-notes';
const VISIBLE_SLUG = 'docs/engineering/read-audit-visible';
const PEER_SLUG = 'docs/engineering/read-audit-peer';
const HIDDEN_SLUG = 'docs/sales/read-audit-hidden';
const QUERY_TEXT = 'sharedreadneedle';
const RESOLVE_PARTIAL = 'audit resolve';

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
  - id: company-sales-user
    email: sales@example.invalid
    idp_subjects:
      - oauth-client:gbrain_cl_sales
groups:
  - id: engineering
    members:
      - company-eng-user
  - id: sales
    members:
      - company-sales-user
policies:
  - id: company-trusted-workspace
    read:
      groups:
        - engineering
        - sales
    write:
      groups:
        - engineering
        - sales
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
  - object_type: doc
    path_prefix: docs/engineering/
    visibility_policy_id: engineering-notes
  - object_type: doc
    path_prefix: docs/sales/
    visibility_policy_id: sales-notes
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

async function seedRows(): Promise<void> {
  await seedPage(VISIBLE_SLUG, ENG_POLICY, `${QUERY_TEXT} visible engineering body`, 'Audit Resolve Visible');
  await seedPage(PEER_SLUG, ENG_POLICY, 'visible graph peer body');
  await seedPage(HIDDEN_SLUG, SALES_POLICY, `${QUERY_TEXT} secret sales body`, 'Audit Resolve Hidden');

  await engine.addLink(VISIBLE_SLUG, PEER_SLUG, 'visible graph relation', 'mentions', undefined, undefined, undefined, {
    fromSourceId: 'company',
    toSourceId: 'company',
    originSourceId: 'company',
  });
  await engine.addLink(VISIBLE_SLUG, HIDDEN_SLUG, 'secret graph relation', 'mentions', undefined, undefined, undefined, {
    fromSourceId: 'company',
    toSourceId: 'company',
    originSourceId: 'company',
  });
}

async function seedPage(slug: string, policyId: string, body: string, title = slug): Promise<void> {
  await engine.putPage(slug, {
    type: 'doc',
    title,
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

async function callAs(name: string, params: Record<string, unknown>, requestId: string): Promise<ToolResult> {
  return dispatchToolCall(engine, name, params, {
    remote: true,
    sourceId: 'company',
    auth: hostedAuth(),
    requestId,
  });
}

async function auditRows(filters: { operation?: string; eventType?: string; requestId?: string } = {}): Promise<any[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.operation) {
    params.push(filters.operation);
    clauses.push(`operation = $${params.length}`);
  }
  if (filters.eventType) {
    params.push(filters.eventType);
    clauses.push(`event_type = $${params.length}`);
  }
  if (filters.requestId) {
    params.push(filters.requestId);
    clauses.push(`request_id = $${params.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return engine.executeRaw(
    `SELECT sequence_id, event_type, request_id, operation, args_hash, content_or_query_hash,
            result_count, object_ids_or_slugs, status, denial_reason
       FROM company_audit_events
       ${where}
      ORDER BY sequence_id`,
    params,
  );
}

function parseToolJson(result: ToolResult): any {
  return JSON.parse(result.content[0]!.text);
}

function jsonColumn<T>(value: unknown): T {
  return typeof value === 'string' ? JSON.parse(value) as T : value as T;
}

describe('hosted company read-result audit', () => {
  test('audits direct read results without raw page bodies or hidden-object metadata', async () => {
    const visible = await callAs('get_page', { slug: VISIBLE_SLUG }, 'req-visible-page');
    expect(visible.isError).toBeUndefined();
    expect(parseToolJson(visible).compiled_truth).toContain('visible engineering body');

    const hidden = await callAs('get_page', { slug: HIDDEN_SLUG }, 'req-hidden-page');
    expect(hidden.isError).toBe(true);
    expect(parseToolJson(hidden)).toMatchObject({ error: 'page_not_found' });

    const readRows = await auditRows({
      operation: 'get_page',
      eventType: 'company.hosted.read_result',
    });
    expect(readRows).toHaveLength(1);
    expect(Number(readRows[0]!.result_count)).toBe(1);
    expect(readRows[0]!.content_or_query_hash).toBeNull();

    const refs = jsonColumn<Array<string | number>>(readRows[0]!.object_ids_or_slugs);
    expect(refs).toContain(VISIBLE_SLUG);
    expect(refs).not.toContain(HIDDEN_SLUG);

    const allRows = await auditRows();
    expect(JSON.stringify(allRows)).not.toContain(HIDDEN_SLUG);
    expect(JSON.stringify(allRows)).not.toContain('secret sales body');
    expect(JSON.stringify(allRows)).not.toContain('visible engineering body');
  });

  test('audits keyword retrieval results after filtering and stores only a query hash', async () => {
    const result = await callAs('search', { query: QUERY_TEXT, limit: 10 }, 'req-search');
    expect(result.isError).toBeUndefined();
    const rows = parseToolJson(result);
    expect(rows.map((row: { slug: string }) => row.slug)).toContain(VISIBLE_SLUG);
    expect(rows.map((row: { slug: string }) => row.slug)).not.toContain(HIDDEN_SLUG);

    const audit = await auditRows({
      operation: 'search',
      eventType: 'company.hosted.read_result',
      requestId: 'req-search',
    });
    expect(audit).toHaveLength(1);
    expect(Number(audit[0]!.result_count)).toBe(rows.length);
    expect(audit[0]!.args_hash).toBeNull();
    expect(audit[0]!.content_or_query_hash).toBe(hashCompanyAuditValue({ query: QUERY_TEXT }));

    const refs = jsonColumn<Array<string | number>>(audit[0]!.object_ids_or_slugs);
    expect(refs).toContain(VISIBLE_SLUG);
    expect(refs).not.toContain(HIDDEN_SLUG);
    expect(JSON.stringify(audit)).not.toContain(QUERY_TEXT);
    expect(JSON.stringify(audit)).not.toContain('secret sales body');
  });

  test('audits graph reads after endpoint filtering', async () => {
    const result = await callAs('get_links', { slug: VISIBLE_SLUG }, 'req-links');
    expect(result.isError).toBeUndefined();
    const links = parseToolJson(result);
    expect(links.map((link: { to_slug: string }) => link.to_slug)).toEqual([PEER_SLUG]);
    expect(JSON.stringify(links)).not.toContain(HIDDEN_SLUG);

    const audit = await auditRows({
      operation: 'get_links',
      eventType: 'company.hosted.read_result',
      requestId: 'req-links',
    });
    expect(audit).toHaveLength(1);
    expect(Number(audit[0]!.result_count)).toBe(1);
    const refs = jsonColumn<Array<string | number>>(audit[0]!.object_ids_or_slugs);
    expect(refs).toContain(VISIBLE_SLUG);
    expect(refs).toContain(PEER_SLUG);
    expect(refs).not.toContain(HIDDEN_SLUG);
    expect(JSON.stringify(audit)).not.toContain('secret graph relation');
  });

  test('audits resolved slug arrays as object refs after filtering', async () => {
    const result = await callAs('resolve_slugs', { partial: RESOLVE_PARTIAL }, 'req-resolve');
    expect(result.isError).toBeUndefined();
    const resolved = parseToolJson(result);
    expect(resolved).toContain(VISIBLE_SLUG);
    expect(resolved).not.toContain(HIDDEN_SLUG);

    const audit = await auditRows({
      operation: 'resolve_slugs',
      eventType: 'company.hosted.read_result',
      requestId: 'req-resolve',
    });
    expect(audit).toHaveLength(1);
    expect(Number(audit[0]!.result_count)).toBe(resolved.length);
    expect(audit[0]!.content_or_query_hash).toBe(hashCompanyAuditValue({ partial: RESOLVE_PARTIAL }));

    const refs = jsonColumn<Array<string | number>>(audit[0]!.object_ids_or_slugs);
    expect(refs).toContain(VISIBLE_SLUG);
    expect(refs).not.toContain(HIDDEN_SLUG);
    expect(JSON.stringify(audit)).not.toContain(RESOLVE_PARTIAL);
  });

  test('summarizes code read results by ids and slugs without snippets or symbols', () => {
    const refs = buildHostedCompanyReadResultAudit('code_refs', {
      symbol: 'visibleNeedle',
    }, {
      count: 1,
      refs: [{
        slug: VISIBLE_SLUG,
        chunk_id: 42,
        snippet: 'do not store this code snippet',
        symbol: 'doNotStoreThisSymbol',
      }],
    });
    expect(refs.result_count).toBe(1);
    expect(refs.object_ids_or_slugs).toEqual([VISIBLE_SLUG, 42]);
    expect(JSON.stringify(refs.object_ids_or_slugs)).not.toContain('snippet');
    expect(JSON.stringify(refs.object_ids_or_slugs)).not.toContain('doNotStoreThisSymbol');

    const traversal = buildHostedCompanyReadResultAudit('code_blast', {
      symbol: 'visibleStart',
    }, {
      result: 'ok',
      depth_groups: [{
        depth: 1,
        nodes: [{ symbol: 'hiddenCallerName', chunk_id: 99 }],
      }],
    });
    expect(traversal.result_count).toBe(1);
    expect(traversal.object_ids_or_slugs).toEqual([99]);
    expect(JSON.stringify(traversal.object_ids_or_slugs)).not.toContain('hiddenCallerName');
  });

  test('fails closed when the read-result audit append fails', async () => {
    const result = await dispatchToolCall(engine, 'get_page', { slug: VISIBLE_SLUG }, {
      remote: true,
      sourceId: 'company',
      auth: hostedAuth(),
      requestId: 'req-read-audit-down',
      companyAuditAppend: async (...args: Parameters<typeof appendCompanyAuditEvent>) => {
        if (args[1].event_type === 'company.hosted.read_result') {
          throw new Error('read audit unavailable');
        }
        return appendCompanyAuditEvent(...args);
      },
    });

    expect(result.isError).toBe(true);
    expect(parseToolJson(result)).toMatchObject({
      error: 'permission_denied',
      message: 'Company audit append failed for hosted company request.',
    });
    expect(result.content[0]!.text).not.toContain('visible engineering body');

    const toolRows = await auditRows({
      operation: 'get_page',
      eventType: 'company.hosted.tool_call',
      requestId: 'req-read-audit-down',
    });
    expect(toolRows.map((row) => row.status)).toEqual(['attempted']);
    const readRows = await auditRows({
      operation: 'get_page',
      eventType: 'company.hosted.read_result',
      requestId: 'req-read-audit-down',
    });
    expect(readRows).toEqual([]);
  });
});
