import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AuthInfo } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { applyCompanyModeSkeleton } from '../src/core/company-mode.ts';
import { applyCompanyLayout } from '../src/core/company-layout.ts';
import { applyCompanyPolicySeed, parseCompanyPolicySeedYaml } from '../src/core/company-policy.ts';
import {
  appendCompanyAuditEvent,
  appendCompanyAuditEventInTransaction,
  hashCompanyAuditPolicyIds,
  type CompanyAuditEventInput,
} from '../src/core/company-audit.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { dispatchToolCall, type ToolResult } from '../src/mcp/dispatch.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const ENG_POLICY = 'engineering-notes';
const SALES_POLICY = 'sales-notes';
const COMPANY_ENG = 'docs/engineering/audit-source';
const COMPANY_ENG_PEER = 'docs/engineering/audit-peer';
const COMPANY_SALES = 'docs/sales/audit-source';
const COMPANY_UNLABELED = 'docs/engineering/audit-unlabeled';

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
  await seedPages();
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
  - id: company-mixed-user
    email: mixed@example.invalid
    idp_subjects:
      - oauth-client:gbrain_cl_mixed
      - client-name:mixed-agent
groups:
  - id: engineering
    members:
      - company-eng-user
      - company-mixed-user
  - id: sales
    members:
      - company-mixed-user
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
  - object_type: decision
    path_prefix: decisions/
    visibility_policy_id: engineering-notes
audit:
  readers:
    groups:
      - engineering
      - sales
`);
}

async function initCompanyBrain(): Promise<void> {
  await applyCompanyModeSkeleton(engine);
  await applyCompanyLayout(engine);
  await applyCompanyPolicySeed(engine, companySeed());
}

async function seedPages(): Promise<void> {
  await seedTextPage(COMPANY_ENG, ENG_POLICY, 'Engineering source body');
  await seedTextPage(COMPANY_ENG_PEER, ENG_POLICY, 'Engineering peer body');
  await seedTextPage(COMPANY_SALES, SALES_POLICY, 'Sales source body');
  await engine.putPage(COMPANY_UNLABELED, {
    type: 'doc',
    title: COMPANY_UNLABELED,
    compiled_truth: 'Unlabeled source body',
    timeline: '',
    frontmatter: {},
  }, { sourceId: 'company' });
}

async function seedTextPage(slug: string, policyId: string, body: string): Promise<void> {
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
}

function hostedAuth(client: 'eng' | 'mixed'): AuthInfo {
  return {
    token: `gbrain_at_${client}`,
    clientId: `gbrain_cl_${client}`,
    clientName: `${client}-agent`,
    scopes: ['read', 'write'],
    sourceId: 'company',
    allowedSources: ['company'],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

function markdown(type: string, title: string, frontmatter: Record<string, unknown> = {}, body = 'Body'): string {
  return serializeMarkdown(frontmatter, body, '', { type, title, tags: [] });
}

function parseToolJson<T = any>(result: ToolResult): T {
  return JSON.parse(result.content[0]!.text) as T;
}

function captureAudit(captured: CompanyAuditEventInput[]) {
  return async (...args: Parameters<typeof appendCompanyAuditEvent>) => {
    captured.push(JSON.parse(JSON.stringify(args[1])) as CompanyAuditEventInput);
    return appendAuditFromProvidedEngine(...args);
  };
}

function appendAuditFromProvidedEngine(...args: Parameters<typeof appendCompanyAuditEvent>) {
  const [auditEngine, input, opts] = args;
  const db = (auditEngine as unknown as { db?: { transaction?: unknown } }).db;
  return typeof db?.transaction === 'function'
    ? appendCompanyAuditEvent(auditEngine, input, opts)
    : appendCompanyAuditEventInTransaction(auditEngine, input, opts);
}

async function callAs(
  client: 'eng' | 'mixed',
  params: Record<string, unknown>,
  captured: CompanyAuditEventInput[] = [],
  requestId = `req-${client}-${captured.length}`,
): Promise<ToolResult> {
  return dispatchToolCall(engine, 'put_page', params, {
    remote: true,
    sourceId: 'company',
    auth: hostedAuth(client),
    requestId,
    companyAuditAppend: captureAudit(captured),
  });
}

async function auditRows(operation = 'put_page'): Promise<any[]> {
  return engine.executeRaw(
    `SELECT sequence_id, event_type, operation, source_scope, policy_decision_id,
            content_or_query_hash, result_count, object_ids_or_slugs, status, denial_reason
       FROM company_audit_events
      WHERE operation = $1
      ORDER BY sequence_id`,
    [operation],
  );
}

function eventPayload<T extends Record<string, unknown>>(event: CompanyAuditEventInput): T {
  return event.content_or_query as T;
}

function capturedEvent(
  captured: CompanyAuditEventInput[],
  eventType: CompanyAuditEventInput['event_type'],
  status?: CompanyAuditEventInput['status'],
): CompanyAuditEventInput {
  const event = captured.find((entry) => entry.event_type === eventType && (!status || entry.status === status));
  expect(event).toBeTruthy();
  return event!;
}

describe('hosted company write audit', () => {
  test('audits allowed hosted put_page writes without storing raw content', async () => {
    const captured: CompanyAuditEventInput[] = [];
    const rawBody = 'Allowed write raw body should only be represented by hashes.';
    const target = 'docs/engineering/write-audit-ok';
    const result = await callAs('eng', {
      slug: target,
      content: markdown('doc', 'Write Audit OK', {}, rawBody),
    }, captured, 'req-write-allowed');

    expect(result.isError).toBeUndefined();
    const writeEvent = capturedEvent(captured, 'company.hosted.write_result', 'succeeded');
    expect(writeEvent.result_count).toBe(1);
    expect(writeEvent.object_ids_or_slugs).toEqual([target]);
    const payload = eventPayload<any>(writeEvent);
    expect(payload.target_source_id).toBe('company');
    expect(payload.target_policy_ids_hash).toBe(hashCompanyAuditPolicyIds([ENG_POLICY]));
    expect(payload.before_content_hash).toBeNull();
    expect(payload.after_content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.visibility_assignment).toBe('path_default');
    expect(JSON.stringify(payload)).not.toContain(rawBody);

    const rows = await auditRows();
    const writeRows = rows.filter((row) => row.event_type === 'company.hosted.write_result');
    expect(writeRows.map((row) => row.status)).toEqual(['attempted', 'succeeded']);
    expect(writeRows[1]).toMatchObject({ status: 'succeeded', denial_reason: null });
    expect(writeRows[1]!.content_or_query_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(rawBody);
  });

  test('audits denied hosted put_page writes and keeps the target unwritten', async () => {
    const captured: CompanyAuditEventInput[] = [];
    const rawBody = 'Denied sales write raw body should only be hashed.';
    const target = 'docs/sales/write-audit-denied';
    const result = await callAs('eng', {
      slug: target,
      content: markdown('doc', 'Write Audit Denied', {}, rawBody),
    }, captured, 'req-write-denied');

    expect(result.isError).toBe(true);
    expect(parseToolJson(result)).toMatchObject({ error: 'permission_denied' });
    expect(await engine.getPage(target, { sourceId: 'company' })).toBeNull();

    const writeEvent = capturedEvent(captured, 'company.hosted.write_result', 'denied');
    expect(writeEvent.denial_reason).toBe('target_policy_not_writable');
    expect(writeEvent.result_count).toBe(0);
    expect(writeEvent.object_ids_or_slugs).toEqual([target]);
    const payload = eventPayload<any>(writeEvent);
    expect(payload.target_policy_ids_hash).toBe(hashCompanyAuditPolicyIds([SALES_POLICY]));
    expect(payload.submitted_content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.after_content_hash).toBeNull();
    expect(JSON.stringify(payload)).not.toContain(rawBody);

    const rows = await auditRows();
    expect(rows.find((row) => row.event_type === 'company.hosted.write_result')).toMatchObject({
      status: 'denied',
      denial_reason: 'target_policy_not_writable',
    });
    expect(JSON.stringify(rows)).not.toContain(rawBody);
  });

  test('fails closed before commit when prepared write audit cannot append', async () => {
    const target = 'docs/engineering/write-audit-append-denied';
    const rawBody = 'Pre-commit audit failure body should not be written.';
    const auditAppend = async (...args: Parameters<typeof appendCompanyAuditEvent>) => {
      if (args[1].event_type === 'company.hosted.write_result' && args[1].status === 'attempted') {
        throw new Error('audit unavailable before write commit');
      }
      return appendAuditFromProvidedEngine(...args);
    };

    const result = await dispatchToolCall(engine, 'put_page', {
      slug: target,
      content: markdown('doc', 'Write Audit Append Denied', {}, rawBody),
    }, {
      remote: true,
      sourceId: 'company',
      auth: hostedAuth('eng'),
      requestId: 'req-write-audit-append-denied',
      companyAuditAppend: auditAppend,
    });

    expect(result.isError).toBe(true);
    expect(parseToolJson(result)).toMatchObject({
      error: 'permission_denied',
      message: 'Company audit append failed for hosted company request.',
    });
    expect(await engine.getPage(target, { sourceId: 'company' })).toBeNull();

    const rows = await auditRows();
    expect(rows.map((row) => `${row.event_type}:${row.status}`)).toEqual([
      'company.hosted.tool_call:attempted',
      'company.hosted.write_result:denied',
    ]);
    expect(rows[1]).toMatchObject({ denial_reason: 'operation_error_permission_denied' });
    expect(JSON.stringify(rows)).not.toContain(rawBody);
  });

  test('fails closed without committing when final write-success audit cannot append', async () => {
    const target = 'docs/engineering/write-audit-final-append-denied';
    const rawBody = 'Final success audit failure body should not be written.';
    const auditAppend = async (...args: Parameters<typeof appendCompanyAuditEvent>) => {
      if (args[1].event_type === 'company.hosted.write_result' && args[1].status === 'succeeded') {
        throw new Error('audit unavailable at write commit');
      }
      return appendAuditFromProvidedEngine(...args);
    };

    const result = await dispatchToolCall(engine, 'put_page', {
      slug: target,
      content: markdown('doc', 'Write Audit Final Append Denied', {}, rawBody),
    }, {
      remote: true,
      sourceId: 'company',
      auth: hostedAuth('eng'),
      requestId: 'req-write-audit-final-append-denied',
      companyAuditAppend: auditAppend,
    });

    expect(result.isError).toBe(true);
    expect(parseToolJson(result)).toMatchObject({
      error: 'permission_denied',
      message: 'Company audit append failed for hosted company request.',
    });
    expect(await engine.getPage(target, { sourceId: 'company' })).toBeNull();

    const rows = await auditRows();
    expect(rows.map((row) => `${row.event_type}:${row.status}`)).toEqual([
      'company.hosted.tool_call:attempted',
      'company.hosted.write_result:attempted',
      'company.hosted.write_result:denied',
    ]);
    expect(rows[2]).toMatchObject({ denial_reason: 'operation_error_permission_denied' });
    expect(JSON.stringify(rows)).not.toContain(rawBody);
  });

  test('marks derived writes denied when enclosing write fails before commit', async () => {
    const target = 'decisions/write-audit-derived-precommit-denied';
    const auditAppend = async (...args: Parameters<typeof appendCompanyAuditEvent>) => {
      if (args[1].event_type === 'company.hosted.write_result' && args[1].status === 'attempted') {
        throw new Error('audit unavailable before derived write commit');
      }
      return appendAuditFromProvidedEngine(...args);
    };

    const result = await dispatchToolCall(engine, 'put_page', {
      slug: target,
      content: markdown('decision', 'Derived Precommit Denied', {
        derived_from: [COMPANY_ENG],
      }, 'Derived precommit failure body should only be hashed.'),
    }, {
      remote: true,
      sourceId: 'company',
      auth: hostedAuth('eng'),
      requestId: 'req-derived-precommit-denied',
      companyAuditAppend: auditAppend,
    });

    expect(result.isError).toBe(true);
    expect(await engine.getPage(target, { sourceId: 'company' })).toBeNull();

    const rows = await auditRows();
    expect(rows.map((row) => `${row.event_type}:${row.status}`)).toEqual([
      'company.hosted.tool_call:attempted',
      'company.hosted.write_result:denied',
      'company.hosted.derived_write:denied',
    ]);
    expect(rows[2]).toMatchObject({ denial_reason: 'operation_error_permission_denied' });
  });

  test('audits overwrites and policy reclassification attempts', async () => {
    const target = 'docs/engineering/write-audit-reclass';
    await seedTextPage(target, ENG_POLICY, 'Existing engineering body');

    const captured: CompanyAuditEventInput[] = [];
    const result = await callAs('mixed', {
      slug: target,
      content: markdown('doc', 'Write Audit Reclass', {
        visibility_policy_ids: [ENG_POLICY, SALES_POLICY],
      }, 'Reclassified body should only be hashed.'),
    }, captured, 'req-write-reclass');

    expect(result.isError).toBeUndefined();
    const page = await engine.getPage(target, { sourceId: 'company' });
    expect(page?.frontmatter.visibility_policy_ids).toEqual([ENG_POLICY, SALES_POLICY]);

    const writeEvent = capturedEvent(captured, 'company.hosted.write_result', 'succeeded');
    const payload = eventPayload<any>(writeEvent);
    expect(payload.overwrite).toBe(true);
    expect(payload.policy_reclassification_attempted).toBe(true);
    expect(payload.existing_policy_ids_hash).toBe(hashCompanyAuditPolicyIds([ENG_POLICY]));
    expect(payload.target_policy_ids_hash).toBe(hashCompanyAuditPolicyIds([ENG_POLICY, SALES_POLICY]));
    expect(payload.before_content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.after_content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('audits attempted overwrites of existing unlabeled pages accurately', async () => {
    const captured: CompanyAuditEventInput[] = [];
    const result = await callAs('eng', {
      slug: COMPANY_UNLABELED,
      content: markdown('doc', 'Unlabeled Overwrite Attempt', {}, 'Unlabeled overwrite body should only be hashed.'),
    }, captured, 'req-write-unlabeled-overwrite');

    expect(result.isError).toBe(true);
    const writeEvent = capturedEvent(captured, 'company.hosted.write_result', 'denied');
    expect(writeEvent.denial_reason).toBe('existing_policy_not_writable');
    const payload = eventPayload<any>(writeEvent);
    expect(payload.overwrite).toBe(true);
    expect(payload.policy_reclassification_attempted).toBe(true);
    expect(payload.before_content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.target_policy_ids_hash).toBe(hashCompanyAuditPolicyIds([ENG_POLICY]));
  });

  test('audits derived visibility inheritance, intersection, and rejection reasons', async () => {
    const inherited: CompanyAuditEventInput[] = [];
    const inheritedResult = await callAs('eng', {
      slug: 'decisions/write-audit-derived-inherit',
      content: markdown('decision', 'Derived Inherit', {
        derived_from: [COMPANY_ENG],
      }, 'Derived inherit body should only be hashed.'),
    }, inherited, 'req-derived-inherit');
    expect(inheritedResult.isError).toBeUndefined();
    let derivedEvent = capturedEvent(inherited, 'company.hosted.derived_write', 'succeeded');
    expect(eventPayload<any>(derivedEvent)).toMatchObject({
      decision: 'inherit',
      reason: 'single_input_inherits',
      input_count: 1,
    });

    const intersected: CompanyAuditEventInput[] = [];
    const intersectedResult = await callAs('eng', {
      slug: 'decisions/write-audit-derived-intersect',
      content: markdown('decision', 'Derived Intersect', {
        derived_from: [COMPANY_ENG, COMPANY_ENG_PEER],
      }, 'Derived intersect body should only be hashed.'),
    }, intersected, 'req-derived-intersect');
    expect(intersectedResult.isError).toBeUndefined();
    derivedEvent = capturedEvent(intersected, 'company.hosted.derived_write', 'succeeded');
    expect(eventPayload<any>(derivedEvent)).toMatchObject({
      decision: 'intersect',
      reason: 'multiple_inputs_intersect',
      input_count: 2,
    });

    const noInput: CompanyAuditEventInput[] = [];
    const noInputResult = await callAs('eng', {
      slug: 'decisions/write-audit-derived-no-input',
      content: markdown('decision', 'Derived No Input', {
        derived_from: [],
      }, 'Derived no input body should only be hashed.'),
    }, noInput, 'req-derived-no-input');
    expect(noInputResult.isError).toBe(true);
    derivedEvent = capturedEvent(noInput, 'company.hosted.derived_write', 'denied');
    expect(derivedEvent.denial_reason).toBe('derived_visibility_no_inputs');
    expect(eventPayload<any>(derivedEvent)).toMatchObject({
      decision: 'reject',
      reason: 'no_inputs',
      input_count: 0,
    });

    const noPolicy: CompanyAuditEventInput[] = [];
    const noPolicyResult = await callAs('eng', {
      slug: 'decisions/write-audit-derived-no-policy',
      content: markdown('decision', 'Derived No Policy', {
        derived_from: [COMPANY_UNLABELED],
      }, 'Derived no policy body should only be hashed.'),
    }, noPolicy, 'req-derived-no-policy');
    expect(noPolicyResult.isError).toBe(true);
    derivedEvent = capturedEvent(noPolicy, 'company.hosted.derived_write', 'denied');
    expect(derivedEvent.denial_reason).toBe('derived_visibility_no_input_policies');
    expect(eventPayload<any>(derivedEvent)).toMatchObject({
      decision: 'reject',
      reason: 'no_input_policies',
      input_count: 1,
    });

    const emptyIntersection: CompanyAuditEventInput[] = [];
    const emptyResult = await callAs('mixed', {
      slug: 'decisions/write-audit-derived-empty',
      content: markdown('decision', 'Derived Empty', {
        derived_from: [COMPANY_ENG, COMPANY_SALES],
      }, 'Derived empty intersection body should only be hashed.'),
    }, emptyIntersection, 'req-derived-empty');
    expect(emptyResult.isError).toBe(true);
    derivedEvent = capturedEvent(emptyIntersection, 'company.hosted.derived_write', 'denied');
    expect(derivedEvent.denial_reason).toBe('derived_visibility_empty_intersection');
    expect(eventPayload<any>(derivedEvent)).toMatchObject({
      decision: 'reject',
      reason: 'empty_intersection',
      input_count: 2,
    });

    const rows = await auditRows();
    expect(JSON.stringify(rows)).not.toContain('Derived inherit body');
    expect(JSON.stringify(rows)).not.toContain('Derived no policy body');
    expect(JSON.stringify(rows)).not.toContain('Derived empty intersection body');
  });
});
