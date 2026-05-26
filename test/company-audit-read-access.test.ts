import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AuthInfo } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { applyCompanyModeSkeleton } from '../src/core/company-mode.ts';
import { applyCompanyLayout } from '../src/core/company-layout.ts';
import { applyCompanyPolicySeed, parseCompanyPolicySeedYaml, type CompanyPolicyApplyResult } from '../src/core/company-policy.ts';
import { buildCompanyRequestContext } from '../src/core/company-request-context.ts';
import {
  appendCompanyAuditEvent,
  type CompanyAuditEventInput,
} from '../src/core/company-audit.ts';
import {
  CompanyAuditReadError,
  readCompanyAuditLog,
  verifyCompanyAuditHashChain,
} from '../src/core/company-audit-read.ts';
import { buildHostedCompanyReadResultAudit } from '../src/mcp/company-read-audit.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const ENG_POLICY = 'engineering-notes';
const SALES_POLICY = 'sales-notes';
const ENG_SLUG = 'docs/engineering/audit-visible';
const SALES_SLUG = 'docs/sales/audit-hidden';

let engine: PGLiteEngine;
let policy: CompanyPolicyApplyResult;

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
  - id: company-sales-user
    email: sales@example.invalid
    idp_subjects:
      - oauth-client:gbrain_cl_sales
      - client-name:sales-agent
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
  policy = await applyCompanyPolicySeed(engine, companySeed());
}

async function seedPages(): Promise<void> {
  await seedPage(ENG_SLUG, ENG_POLICY, 'Engineering audit-visible body.');
  await seedPage(SALES_SLUG, SALES_POLICY, 'Sales audit-hidden body.');
  await engine.upsertChunks(ENG_SLUG, [{
    chunk_index: 0,
    chunk_text: 'Engineering audit-visible chunk.',
    chunk_source: 'compiled_truth',
  }], { sourceId: 'company' });
  await engine.upsertChunks(SALES_SLUG, [{
    chunk_index: 0,
    chunk_text: 'Sales audit-hidden chunk.',
    chunk_source: 'compiled_truth',
  }], { sourceId: 'company' });
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
}

async function pageId(slug: string): Promise<number> {
  const rows = await engine.executeRaw<{ id: number | string }>(
    `SELECT id FROM pages WHERE slug = $1 AND source_id = $2`,
    [slug, 'company'],
  );
  return Number(rows[0]!.id);
}

async function firstChunkId(slug: string): Promise<number> {
  const rows = await engine.executeRaw<{ id: number | string }>(
    `SELECT cc.id
       FROM content_chunks cc
       JOIN pages p ON p.id = cc.page_id
      WHERE p.slug = $1 AND p.source_id = $2
      ORDER BY cc.id
      LIMIT 1`,
    [slug, 'company'],
  );
  return Number(rows[0]!.id);
}

function hostedAuth(client: 'eng' | 'sales'): AuthInfo {
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

function requestContext(client: 'eng' | 'sales') {
  return buildCompanyRequestContext({
    requestId: `req-audit-read-${client}`,
    sourceId: 'company',
    allowedSources: ['company'],
    remote: true,
    auth: hostedAuth(client),
    storage: policy.storage,
    metadata: policy.metadata,
  });
}

function baseEvent(overrides: Partial<CompanyAuditEventInput>): CompanyAuditEventInput {
  return {
    event_type: 'company.hosted.read_result',
    timestamp: '2026-05-26T10:00:00.000Z',
    request_id: 'req-audit-event',
    user_id: 'company-eng-user',
    client_id: 'gbrain_cl_eng',
    client_name: 'eng-agent',
    transport: 'hosted_mcp_oauth',
    operation: 'get_page',
    source_scope: { source_id: 'company', allowed_source_ids: ['company'] },
    policy_decision_id: 'cpd_audit_read',
    policy_version: policy.metadata.policy_version,
    policy_hash: policy.metadata.policy_hash,
    readable_policy_ids: [ENG_POLICY],
    writable_policy_ids: [ENG_POLICY],
    result_count: 1,
    object_ids_or_slugs: [ENG_SLUG],
    status: 'succeeded',
    ...overrides,
  };
}

async function seedAuditRows(): Promise<void> {
  await appendCompanyAuditEvent(engine, baseEvent({
    event_id: 'evt-eng-visible',
    request_id: 'req-eng-visible',
    object_ids_or_slugs: [ENG_SLUG],
    user_id: 'company-eng-user',
    readable_policy_ids: [ENG_POLICY],
    writable_policy_ids: [ENG_POLICY],
  }));
  await appendCompanyAuditEvent(engine, baseEvent({
    event_id: 'evt-sales-hidden',
    request_id: 'req-sales-hidden',
    object_ids_or_slugs: [SALES_SLUG],
    user_id: 'company-sales-user',
    client_id: 'gbrain_cl_sales',
    client_name: 'sales-agent',
    readable_policy_ids: [SALES_POLICY],
    writable_policy_ids: [SALES_POLICY],
  }));
}

describe('company audit read access', () => {
  test('allows configured audit readers and filters hidden object rows', async () => {
    await seedAuditRows();

    const result = await readCompanyAuditLog(engine, {
      requestContext: requestContext('eng'),
      limit: 10,
    });

    expect(result.access.mode).toBe('audit_reader');
    expect(result.access.filtered_by_object_policy).toBe(true);
    expect(result.redaction.hidden_object_rows_filtered).toBe(true);
    expect(result.events.map((event) => event.event_id)).toEqual(['evt-eng-visible']);
    expect(result.events[0]!.object_ids_or_slugs).toEqual([ENG_SLUG]);
    expect(JSON.stringify(result)).not.toContain(SALES_SLUG);
    expect(JSON.stringify(result)).not.toContain('Sales audit-hidden body');
  });

  test('filters opaque numeric audit refs for permissioned readers', async () => {
    const readablePageId = await pageId(ENG_SLUG);
    const readableChunkId = await firstChunkId(ENG_SLUG);
    const factSummary = buildHostedCompanyReadResultAudit('recall', {}, {
      facts: [{ fact_id: readablePageId, confidence: 0.9 }],
    });

    expect(factSummary.object_ids_or_slugs).toEqual([readablePageId]);

    await appendCompanyAuditEvent(engine, baseEvent({
      event_id: 'evt-hidden-page-numeric-collision',
      request_id: 'req-hidden-page-numeric-collision',
      operation: 'get_page',
      user_id: 'company-sales-user',
      client_id: 'gbrain_cl_sales',
      client_name: 'sales-agent',
      readable_policy_ids: [SALES_POLICY],
      writable_policy_ids: [SALES_POLICY],
      object_ids_or_slugs: [readablePageId],
    }));
    await appendCompanyAuditEvent(engine, baseEvent({
      event_id: 'evt-hidden-chunk-numeric-collision',
      request_id: 'req-hidden-chunk-numeric-collision',
      operation: 'get_chunks',
      user_id: 'company-sales-user',
      client_id: 'gbrain_cl_sales',
      client_name: 'sales-agent',
      readable_policy_ids: [SALES_POLICY],
      writable_policy_ids: [SALES_POLICY],
      object_ids_or_slugs: [readableChunkId],
    }));
    await appendCompanyAuditEvent(engine, baseEvent({
      event_id: 'evt-hidden-fact-numeric',
      request_id: 'req-hidden-fact-numeric',
      operation: 'recall',
      user_id: 'company-sales-user',
      client_id: 'gbrain_cl_sales',
      client_name: 'sales-agent',
      readable_policy_ids: [SALES_POLICY],
      writable_policy_ids: [SALES_POLICY],
      object_ids_or_slugs: factSummary.object_ids_or_slugs,
    }));

    const readerResult = await readCompanyAuditLog(engine, {
      requestContext: requestContext('eng'),
      limit: 10,
    });

    expect(readerResult.events).toHaveLength(0);
    expect(readerResult.redaction.hidden_object_rows_filtered).toBe(true);
    expect(JSON.stringify(readerResult.events)).not.toContain(String(readablePageId));
    expect(JSON.stringify(readerResult.events)).not.toContain(String(readableChunkId));

    const adminResult = await readCompanyAuditLog(engine, {
      trustedLocalAdmin: true,
      limit: 10,
    });

    expect(adminResult.events.map((event) => event.event_id)).toEqual([
      'evt-hidden-fact-numeric',
      'evt-hidden-chunk-numeric-collision',
      'evt-hidden-page-numeric-collision',
    ]);
    expect(adminResult.events.some((event) => event.object_ids_or_slugs.includes(readablePageId))).toBe(true);
    expect(adminResult.events.some((event) => event.object_ids_or_slugs.includes(readableChunkId))).toBe(true);
  });

  test('denies non-audit readers even when they can read their own policy', async () => {
    await seedAuditRows();

    try {
      await readCompanyAuditLog(engine, {
        requestContext: requestContext('sales'),
        limit: 10,
      });
      throw new Error('expected audit read denial');
    } catch (e) {
      expect(e).toBeInstanceOf(CompanyAuditReadError);
      expect((e as CompanyAuditReadError).code).toBe('permission_denied');
    }
  });

  test('redacts denial reasons for permissioned audit readers', async () => {
    const secretReason = 'target_policy_not_writable_hidden_sales';
    await appendCompanyAuditEvent(engine, baseEvent({
      event_id: 'evt-denied-no-ref',
      event_type: 'company.hosted.denial',
      operation: 'get_page',
      object_ids_or_slugs: [],
      result_count: 0,
      status: 'denied',
      denial_reason: secretReason,
    }));

    const result = await readCompanyAuditLog(engine, {
      requestContext: requestContext('eng'),
      limit: 10,
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.status).toBe('denied');
    expect(result.events[0]!.denial_reason).toBeNull();
    expect(result.events[0]!.denial_reason_redacted).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secretReason);
  });

  test('trusted local admin reads all rows with denial reasons', async () => {
    await seedAuditRows();
    await appendCompanyAuditEvent(engine, baseEvent({
      event_id: 'evt-admin-denial',
      event_type: 'company.hosted.denial',
      object_ids_or_slugs: [SALES_SLUG],
      result_count: 0,
      status: 'denied',
      denial_reason: 'target_policy_not_writable',
    }));

    const result = await readCompanyAuditLog(engine, {
      trustedLocalAdmin: true,
      limit: 10,
    });

    expect(result.access.mode).toBe('trusted_local_admin');
    expect(result.events.map((event) => event.event_id)).toEqual([
      'evt-admin-denial',
      'evt-sales-hidden',
      'evt-eng-visible',
    ]);
    expect(result.events[0]!.denial_reason).toBe('target_policy_not_writable');
    expect(result.events[0]!.denial_reason_redacted).toBe(false);
  });

  test('verifies valid audit chains and detects modified rows', async () => {
    await seedAuditRows();

    const valid = await verifyCompanyAuditHashChain(engine);
    expect(valid.valid).toBe(true);
    expect(valid.issues).toEqual([]);

    await engine.executeRaw(
      `UPDATE company_audit_events SET result_count = 2 WHERE event_id = $1`,
      ['evt-eng-visible'],
    );

    const tampered = await verifyCompanyAuditHashChain(engine);
    expect(tampered.valid).toBe(false);
    expect(tampered.issues.map((issue) => issue.code)).toContain('event_hash_mismatch');
  });

  test('detects missing middle rows through previous-hash continuity', async () => {
    await appendCompanyAuditEvent(engine, baseEvent({ event_id: 'evt-chain-a', request_id: 'req-chain-a' }));
    await appendCompanyAuditEvent(engine, baseEvent({ event_id: 'evt-chain-b', request_id: 'req-chain-b' }));
    await appendCompanyAuditEvent(engine, baseEvent({ event_id: 'evt-chain-c', request_id: 'req-chain-c' }));

    await engine.executeRaw(`DELETE FROM company_audit_events WHERE event_id = $1`, ['evt-chain-b']);

    const result = await verifyCompanyAuditHashChain(engine);
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('previous_hash_mismatch');
  });
});
