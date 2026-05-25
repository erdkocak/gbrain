import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AuthInfo } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { applyCompanyModeSkeleton } from '../src/core/company-mode.ts';
import { applyCompanyLayout } from '../src/core/company-layout.ts';
import { applyCompanyPolicySeed, parseCompanyPolicySeedYaml } from '../src/core/company-policy.ts';
import { COMPANY_HOSTED_TOOL_GATE_DENIAL } from '../src/core/company-hosted-tool-gate.ts';
import { appendCompanyAuditEvent, hashCompanyAuditValue } from '../src/core/company-audit.ts';
import {
  dispatchToolCall,
  listVisibleOperationsForDispatch,
  type ToolResult,
} from '../src/mcp/dispatch.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const READABLE_POLICY = 'engineering-notes';
const READABLE_SLUG = 'docs/engineering/audit-control';

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
path_defaults:
  - object_type: doc
    path_prefix: docs/engineering/
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

function hostedAuth(overrides: Partial<AuthInfo> = {}): AuthInfo {
  return {
    token: 'gbrain_at_eng',
    clientId: 'gbrain_cl_eng',
    clientName: 'eng-agent',
    scopes: ['read', 'write'],
    sourceId: 'company',
    allowedSources: ['company'],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

async function seedReadablePage(): Promise<void> {
  await engine.putPage(READABLE_SLUG, {
    type: 'doc',
    title: 'Audit Control',
    compiled_truth: 'Visible engineering audit fixture.',
    timeline: '',
    frontmatter: {
      visibility_policy_id: READABLE_POLICY,
      visibility_policy_ids: [READABLE_POLICY],
    },
  }, { sourceId: 'company' });
}

async function auditRows(operation?: string): Promise<any[]> {
  const where = operation ? `WHERE operation = $1` : '';
  const params = operation ? [operation] : [];
  return engine.executeRaw(
    `SELECT sequence_id, event_type, request_id, session_id, user_id, client_id, client_name,
            transport, operation, source_scope, policy_decision_id, policy_version, policy_hash,
            readable_policy_ids_hash, writable_policy_ids_hash, args_hash, result_count,
            object_ids_or_slugs, status, denial_reason
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

describe('hosted company dispatch audit', () => {
  test('audits hosted tool lists with caller, source scope, and reviewed tool names', async () => {
    const visible = await listVisibleOperationsForDispatch(engine, {
      remote: true,
      sourceId: 'company',
      auth: hostedAuth(),
      requestId: 'req-tool-list',
      sessionId: 'sess-tool-list',
    });

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      event_type: 'company.hosted.tool_list',
      request_id: 'req-tool-list',
      session_id: 'sess-tool-list',
      user_id: 'company-eng-user',
      client_id: 'gbrain_cl_eng',
      client_name: 'eng-agent',
      transport: 'hosted_mcp_oauth',
      operation: 'tools/list',
      status: 'succeeded',
      denial_reason: null,
    });
    expect(Number(row.result_count)).toBe(visible.length);
    expect(row.policy_hash).toMatch(/^[0-9a-f]{64}$/);

    const scope = jsonColumn<any>(row.source_scope);
    expect(scope).toMatchObject({
      source_id: 'company',
      requested_source_id: null,
      allowed_source_ids: ['company'],
      used_source_override: false,
      used_allowed_sources_override: false,
      federated_read: false,
    });

    const reviewedTools = jsonColumn<string[]>(row.object_ids_or_slugs);
    expect(reviewedTools).toContain('whoami');
    expect(reviewedTools).toContain('get_page');
    expect(reviewedTools).not.toContain('get_health');
  });

  test('audits hosted tool call attempts and success without storing raw args', async () => {
    await seedReadablePage();
    const params = { slug: READABLE_SLUG };

    const result = await dispatchToolCall(engine, 'get_page', params, {
      remote: true,
      sourceId: 'company',
      auth: hostedAuth(),
      requestId: 'req-get-page',
    });

    expect(result.isError).toBeUndefined();
    expect(parseToolJson(result).slug).toBe(READABLE_SLUG);

    const rows = await auditRows('get_page');
    expect(rows.map((row) => row.status)).toEqual(['attempted', 'succeeded']);
    for (const row of rows) {
      expect(row.event_type).toBe('company.hosted.tool_call');
      expect(row.request_id).toBe('req-get-page');
      expect(row.user_id).toBe('company-eng-user');
      expect(row.policy_decision_id).toBeTruthy();
      expect(row.args_hash).toBe(hashCompanyAuditValue(params));
      expect(jsonColumn<unknown[]>(row.object_ids_or_slugs)).toEqual([]);
    }
    expect(JSON.stringify(rows)).not.toContain(READABLE_SLUG);
  });

  test('does not persist caller-supplied session ids as audit scalar ids', async () => {
    await seedReadablePage();
    const rawSessionId = 'raw prompt session id should not persist';

    const result = await dispatchToolCall(engine, 'get_page', {
      slug: READABLE_SLUG,
      session_id: rawSessionId,
    }, {
      remote: true,
      sourceId: 'company',
      auth: hostedAuth(),
      requestId: 'req-raw-session',
    });

    expect(result.isError).toBeUndefined();
    const rows = await auditRows('get_page');
    expect(rows.map((row) => row.session_id)).toEqual([null, null]);
    expect(JSON.stringify(rows)).not.toContain(rawSessionId);
  });

  test('audits unresolved identity denials without exposing object metadata', async () => {
    const result = await dispatchToolCall(engine, 'whoami', {}, {
      remote: true,
      sourceId: 'company',
      auth: hostedAuth({ clientId: 'gbrain_cl_unknown', clientName: 'unknown-agent' }),
      requestId: 'req-unresolved',
    });

    expect(result.isError).toBe(true);
    expect(parseToolJson(result)).toMatchObject({
      error: 'permission_denied',
      message: 'Company policy context is required for hosted company requests.',
    });

    const rows = await auditRows('whoami');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_type: 'company.hosted.denial',
      request_id: 'req-unresolved',
      user_id: null,
      client_id: 'gbrain_cl_unknown',
      operation: 'whoami',
      status: 'denied',
      denial_reason: 'request_gate_unresolved_identity',
    });
    expect(jsonColumn<unknown[]>(rows[0]!.object_ids_or_slugs)).toEqual([]);
  });

  test('audits stale policy-context denials', async () => {
    const metadataRaw = await engine.getConfig('company.policy.metadata');
    const metadata = JSON.parse(metadataRaw!);
    metadata.policy_hash = '0'.repeat(64);
    await engine.setConfig('company.policy.metadata', JSON.stringify(metadata));

    const result = await dispatchToolCall(engine, 'whoami', {}, {
      remote: true,
      sourceId: 'company',
      auth: hostedAuth(),
      requestId: 'req-stale-policy',
    });

    expect(result.isError).toBe(true);
    const rows = await auditRows('whoami');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_type: 'company.hosted.denial',
      request_id: 'req-stale-policy',
      client_id: 'gbrain_cl_eng',
      operation: 'whoami',
      status: 'denied',
      denial_reason: 'request_gate_missing_policy_context',
      policy_hash: null,
    });
  });

  test('audits unreviewed hosted tool denials', async () => {
    const result = await dispatchToolCall(engine, 'get_health', {}, {
      remote: true,
      sourceId: 'company',
      auth: hostedAuth(),
      requestId: 'req-unreviewed-tool',
    });

    expect(result.isError).toBe(true);
    expect(parseToolJson(result)).toMatchObject({
      error: 'permission_denied',
      message: COMPANY_HOSTED_TOOL_GATE_DENIAL,
    });

    const rows = await auditRows('get_health');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_type: 'company.hosted.denial',
      request_id: 'req-unreviewed-tool',
      user_id: 'company-eng-user',
      operation: 'get_health',
      status: 'denied',
      denial_reason: 'hosted_tool_gate_denied',
    });
    expect(jsonColumn<unknown[]>(rows[0]!.object_ids_or_slugs)).toEqual([]);
  });

  test('audits unknown hosted tool calls without persisting the raw attempted name', async () => {
    const rawToolName = 'not_a_reviewed_tool_raw_prompt_value';
    const result = await dispatchToolCall(engine, rawToolName, {}, {
      remote: true,
      sourceId: 'company',
      auth: hostedAuth(),
      requestId: 'req-unknown-tool',
    });

    expect(result.isError).toBe(true);
    expect(parseToolJson(result).error).toBe('unknown_tool');

    const rows = await auditRows('unknown_tool');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_type: 'company.hosted.denial',
      request_id: 'req-unknown-tool',
      user_id: 'company-eng-user',
      operation: 'unknown_tool',
      status: 'denied',
      denial_reason: 'unknown_tool',
    });
    expect(JSON.stringify(rows)).not.toContain(rawToolName);
  });

  test('denies unreviewed tools before validating caller parameter shape', async () => {
    const localOnly = await dispatchToolCall(engine, 'file_url', {}, {
      remote: true,
      sourceId: 'company',
      auth: hostedAuth(),
      requestId: 'req-local-only-shape',
    });
    expect(localOnly.isError).toBe(true);
    expect(parseToolJson(localOnly)).toMatchObject({
      error: 'permission_denied',
      message: 'file_url is local-only and cannot be invoked by remote MCP callers.',
    });

    const mutating = await dispatchToolCall(engine, 'submit_job', {}, {
      remote: true,
      sourceId: 'company',
      auth: hostedAuth(),
      requestId: 'req-mutating-shape',
    });
    expect(mutating.isError).toBe(true);
    expect(parseToolJson(mutating)).toMatchObject({
      error: 'permission_denied',
      message: 'Hosted company write access is not enabled for this tool.',
    });

    const rows = await auditRows();
    expect(rows.filter((row) => row.operation === 'file_url')).toHaveLength(1);
    expect(rows.find((row) => row.operation === 'file_url')).toMatchObject({
      event_type: 'company.hosted.denial',
      denial_reason: 'local_only_tool',
      status: 'denied',
    });
    expect(rows.find((row) => row.operation === 'submit_job')).toMatchObject({
      event_type: 'company.hosted.denial',
      denial_reason: 'hosted_write_gate_denied',
      status: 'denied',
    });
    expect(JSON.stringify(rows)).not.toContain('invalid_params');
  });

  test('records only the pre-handler control-plane attempt for hosted writes in this substage', async () => {
    const appendCalls: string[] = [];
    const auditAppend = async (...args: Parameters<typeof appendCompanyAuditEvent>) => {
      appendCalls.push(`${args[1].operation}:${args[1].status}`);
      if (args[1].status !== 'attempted') {
        throw new Error('final hosted write status audit is deferred');
      }
      return appendCompanyAuditEvent(...args);
    };

    const result = await dispatchToolCall(engine, 'put_page', {
      slug: READABLE_SLUG,
      content: '# Audit Control\n\nVisible engineering audit fixture.',
    }, {
      remote: true,
      sourceId: 'company',
      auth: hostedAuth(),
      requestId: 'req-put-page-attempt',
      companyAuditAppend: auditAppend,
    });

    expect(result.isError).toBeUndefined();
    expect(appendCalls).toEqual(['put_page:attempted']);

    const page = await engine.getPage(READABLE_SLUG, { sourceId: 'company' });
    expect(page?.slug).toBe(READABLE_SLUG);

    const rows = await auditRows('put_page');
    expect(rows.map((row) => row.status)).toEqual(['attempted']);
  });

  test('fails closed when required audit append fails and keeps whoami best-effort', async () => {
    const failingAuditAppend = async () => {
      throw new Error('audit unavailable');
    };

    const visible = await listVisibleOperationsForDispatch(engine, {
      remote: true,
      sourceId: 'company',
      auth: hostedAuth(),
      companyAuditAppend: failingAuditAppend,
    });
    expect(visible).toEqual([]);

    await seedReadablePage();
    const denied = await dispatchToolCall(engine, 'get_page', { slug: READABLE_SLUG }, {
      remote: true,
      sourceId: 'company',
      auth: hostedAuth(),
      companyAuditAppend: failingAuditAppend,
    });
    expect(denied.isError).toBe(true);
    expect(parseToolJson(denied)).toMatchObject({
      error: 'permission_denied',
      message: 'Company audit append failed for hosted company request.',
    });

    const support = await dispatchToolCall(engine, 'whoami', {}, {
      remote: true,
      sourceId: 'company',
      auth: hostedAuth(),
      companyAuditAppend: failingAuditAppend,
    });
    expect(support.isError).toBeUndefined();
    expect(parseToolJson(support).transport).toBe('oauth');
  });
});
