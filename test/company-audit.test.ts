import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';
import { buildCompanyPermissionStatus } from '../src/core/company-permission-status.ts';
import {
  COMPANY_AUDIT_EVENT_TYPES,
  COMPANY_AUDIT_REQUIRED_FIELDS,
  CompanyAuditError,
  type CompanyAuditEventInput,
  appendCompanyAuditEvent,
  applyCompanyAuditMutation,
  buildCompanyAuditEventRecord,
  canonicalCompanyAuditJson,
  hashCompanyAuditValue,
} from '../src/core/company-audit.ts';

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
  await engine.executeRaw(`TRUNCATE company_audit_events, company_audit_chain_state RESTART IDENTITY CASCADE`);
});

function baseEvent(overrides: Partial<CompanyAuditEventInput> = {}): CompanyAuditEventInput {
  return {
    event_type: 'company.hosted.read_result' as const,
    timestamp: '2026-05-25T12:00:00.000Z',
    request_id: 'req-company-audit',
    session_id: 'sess-company-audit',
    user_id: 'company-user-a',
    client_id: 'gbrain_cl_company_a',
    client_name: 'company-agent-a',
    transport: 'http-mcp',
    operation: 'search',
    source_scope: { source_id: 'company', allowed_source_ids: ['company'] },
    policy_decision_id: 'decision-a',
    policy_version: 'policy-v1',
    policy_hash: 'a'.repeat(64),
    readable_policy_ids: ['company-trusted-workspace'],
    writable_policy_ids: ['company-trusted-workspace'],
    result_count: 1,
    object_ids_or_slugs: ['company:meetings/example'],
    status: 'succeeded' as const,
    ...overrides,
  };
}

describe('company audit substrate', () => {
  test('schema and constants mirror the permission-status audit handoff', async () => {
    const status = buildCompanyPermissionStatus();
    expect([...COMPANY_AUDIT_EVENT_TYPES] as string[]).toEqual(status.audit_handoff.event_types);
    expect([...COMPANY_AUDIT_REQUIRED_FIELDS] as string[]).toEqual(status.audit_handoff.minimum_event_shape.required_fields);

    const migration = MIGRATIONS.find((m) => m.version === 90);
    expect(migration?.name).toBe('company_audit_events');
    expect(migration?.sql).toContain('CREATE TABLE IF NOT EXISTS company_audit_events');
    expect(migration?.sql).toContain('company.hosted.policy_decision');

    const columns = await engine.executeRaw<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_name = 'company_audit_events'
        ORDER BY ordinal_position`,
    );
    const names = columns.map((row) => row.column_name);
    expect(names).toContain('event_id');
    expect(names).toContain('event_type');
    expect(names).toContain('event_timestamp');
    expect(names).toContain('args_hash');
    expect(names).toContain('content_or_query_hash');
    expect(names).toContain('previous_event_hash');
    expect(names).toContain('event_hash');
    expect(names).not.toContain('args');
    expect(names).not.toContain('content');
    expect(names).not.toContain('query_text');
    expect(names).not.toContain('page_body');
  });

  test('canonical JSON and event hashes are deterministic', () => {
    expect(canonicalCompanyAuditJson({ b: 2, a: [3, { d: 4, c: 5 }] }))
      .toBe('{"a":[3,{"c":5,"d":4}],"b":2}');
    expect(hashCompanyAuditValue({ b: 2, a: 1 })).toBe(hashCompanyAuditValue({ a: 1, b: 2 }));

    const first = buildCompanyAuditEventRecord(baseEvent({
      event_id: 'evt-deterministic',
      args: { z: 1, a: ['company', 'audit'] },
      content_or_query: { query: 'raw query text is hashed only' },
    }), null);
    const second = buildCompanyAuditEventRecord(baseEvent({
      event_id: 'evt-deterministic',
      args: { a: ['company', 'audit'], z: 1 },
      content_or_query: { query: 'raw query text is hashed only' },
    }), null);

    expect(first.args_hash).toBe(second.args_hash);
    expect(first.content_or_query_hash).toBe(second.content_or_query_hash);
    expect(first.event_hash).toBe(second.event_hash);
    expect(first.event_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('append order records a hash chain', async () => {
    const first = await appendCompanyAuditEvent(engine, baseEvent({
      event_id: 'evt-chain-1',
      result_count: 1,
      object_ids_or_slugs: ['company:meetings/a'],
    }));
    const second = await appendCompanyAuditEvent(engine, baseEvent({
      event_id: 'evt-chain-2',
      result_count: 2,
      object_ids_or_slugs: ['company:meetings/a', 'company:meetings/b'],
    }));

    expect(first.previous_event_hash).toBeNull();
    expect(second.previous_event_hash).toBe(first.event_hash);

    const rows = await engine.executeRaw<{
      event_id: string;
      previous_event_hash: string | null;
      event_hash: string;
    }>(
      `SELECT event_id, previous_event_hash, event_hash
         FROM company_audit_events
        ORDER BY sequence_id`,
    );
    expect(rows.map((row) => row.event_id)).toEqual(['evt-chain-1', 'evt-chain-2']);
    expect(rows[1]!.previous_event_hash).toBe(rows[0]!.event_hash);

    const state = await engine.executeRaw<{ last_event_hash: string | null }>(
      `SELECT last_event_hash FROM company_audit_chain_state WHERE chain_id = 'hosted_company'`,
    );
    expect(state[0]!.last_event_hash).toBe(second.event_hash);
  });

  test('raw args and content are reduced to hashes before storage', async () => {
    const secret = 'raw page body and prompt should never land in audit rows';
    const record = await appendCompanyAuditEvent(engine, baseEvent({
      event_id: 'evt-redaction',
      args: { slug: 'meetings/example', body: secret },
      content_or_query: { prompt: secret },
    }));

    expect(record.args_hash).toBe(hashCompanyAuditValue({ slug: 'meetings/example', body: secret }));
    expect(record.content_or_query_hash).toBe(hashCompanyAuditValue({ prompt: secret }));
    expect(JSON.stringify(record)).not.toContain(secret);

    const rows = await engine.executeRaw<Record<string, unknown>>(
      `SELECT * FROM company_audit_events WHERE event_id = $1`,
      ['evt-redaction'],
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(secret);
    expect(rows[0]!.args_hash).toBe(record.args_hash);
    expect(rows[0]!.content_or_query_hash).toBe(record.content_or_query_hash);

    expect(() => buildCompanyAuditEventRecord(baseEvent({
      object_ids_or_slugs: [{ body: secret } as never],
    }), null)).toThrow(CompanyAuditError);
  });

  test('routing scope cannot persist raw body, query, prompt, or unknown metadata', () => {
    const secret = 'raw query body prompt must not fit source scope';
    const invalidScopes: Array<Partial<CompanyAuditEventInput>> = [
      { source_scope: { source_id: secret } },
      { source_scope: { requested_source_id: secret } },
      { source_scope: { allowed_source_ids: ['company', secret] } },
      { source_scope: { source_id: 'company', prompt: secret } as never },
      { source_scope: { source_id: 'company', used_source_override: 'yes' as never } },
    ];

    for (const overrides of invalidScopes) {
      expect(() => buildCompanyAuditEventRecord(baseEvent(overrides), null)).toThrow(CompanyAuditError);
    }

    const record = buildCompanyAuditEventRecord(baseEvent({
      source_scope: {
        source_id: 'company',
        requested_source_id: '__all__',
        allowed_source_ids: ['shared', 'company', 'company'],
        used_source_override: true,
        used_allowed_sources_override: false,
        federated_read: true,
      },
    }), null);
    expect(record.source_scope).toEqual({
      source_id: 'company',
      requested_source_id: '__all__',
      allowed_source_ids: ['company', 'shared'],
      used_source_override: true,
      used_allowed_sources_override: false,
      federated_read: true,
    });
  });

  test('caller-provided hash fields must be canonical hashes', async () => {
    const secret = 'raw prompt body query should not be accepted as a hash';
    const invalidHashes: Array<Partial<CompanyAuditEventInput>> = [
      { policy_hash: secret },
      { args_hash: secret },
      { content_or_query_hash: secret },
      { readable_policy_ids_hash: secret },
      { writable_policy_ids_hash: secret },
    ];

    for (const overrides of invalidHashes) {
      expect(() => buildCompanyAuditEventRecord(baseEvent(overrides), null)).toThrow(CompanyAuditError);
    }

    expect(() => buildCompanyAuditEventRecord(baseEvent({
      args: { slug: 'meetings/example' },
      args_hash: 'b'.repeat(64),
    }), null)).toThrow(CompanyAuditError);
    expect(() => buildCompanyAuditEventRecord(baseEvent({
      readable_policy_ids: ['company-trusted-workspace'],
      readable_policy_ids_hash: 'c'.repeat(64),
    }), null)).toThrow(CompanyAuditError);

    try {
      await appendCompanyAuditEvent(engine, baseEvent({
        event_id: 'evt-invalid-hash',
        content_or_query_hash: secret,
      }));
      throw new Error('expected invalid audit hash to fail');
    } catch (err) {
      expect(err).toBeInstanceOf(CompanyAuditError);
    }

    const rows = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM company_audit_events WHERE event_id = $1`,
      ['evt-invalid-hash'],
    );
    expect(Number(rows[0]!.count)).toBe(0);
  });

  test('application mutation API rejects update and delete attempts', async () => {
    await applyCompanyAuditMutation(engine, {
      kind: 'append',
      event: baseEvent({ event_id: 'evt-append-only' }),
    });

    for (const mutation of [
      { kind: 'update' as const, event_id: 'evt-append-only', changes: { status: 'failed' } },
      { kind: 'delete' as const, event_id: 'evt-append-only' },
    ]) {
      try {
        await applyCompanyAuditMutation(engine, mutation);
        throw new Error('expected append-only mutation to fail');
      } catch (err) {
        expect(err).toBeInstanceOf(CompanyAuditError);
        expect((err as CompanyAuditError).code).toBe('append_only_violation');
      }
    }

    const rows = await engine.executeRaw<{ event_id: string; status: string }>(
      `SELECT event_id, status FROM company_audit_events ORDER BY sequence_id`,
    );
    expect(rows).toEqual([{ event_id: 'evt-append-only', status: 'succeeded' }]);
  });
});
