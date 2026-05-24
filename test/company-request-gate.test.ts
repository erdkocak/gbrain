import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AuthInfo } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { applyCompanyModeSkeleton } from '../src/core/company-mode.ts';
import { applyCompanyLayout } from '../src/core/company-layout.ts';
import {
  applyCompanyPolicySeed,
  buildCompanyPolicyMetadata,
  buildCompanyPolicyStorage,
  parseCompanyPolicySeedYaml,
} from '../src/core/company-policy.ts';
import { evaluateHostedCompanyRequestGate } from '../src/core/company-request-gate.ts';
import { buildOperationContext, dispatchToolCall } from '../src/mcp/dispatch.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

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
});

function companySeed() {
  return parseCompanyPolicySeedYaml(`
version: 1
users:
  - id: company-alice
    email: alice@example.invalid
    idp_subjects:
      - oauth-client:gbrain_cl_alice
      - client-name:alice-agent
groups:
  - id: company-pilot-admins
    members:
      - company-alice
policies:
  - id: company-trusted-workspace
    read:
      groups:
        - company-pilot-admins
    write:
      groups:
        - company-pilot-admins
path_defaults:
  - object_type: meeting
    path_prefix: meetings/
    visibility_policy_id: company-trusted-workspace
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

function hostedAuth(overrides: Partial<AuthInfo> = {}): AuthInfo {
  return {
    token: 'gbrain_at_test',
    clientId: 'gbrain_cl_alice',
    clientName: 'alice-agent',
    scopes: ['read', 'write'],
    sourceId: 'company',
    allowedSources: ['company'],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

function parseToolJson(result: Awaited<ReturnType<typeof dispatchToolCall>>): any {
  return JSON.parse(result.content[0]!.text);
}

describe('hosted company request gate', () => {
  test('allows hosted OAuth requests with resolved company identity and policy context', async () => {
    await initCompanyBrain();

    const result = await dispatchToolCall(engine, 'whoami', {}, {
      remote: true,
      sourceId: 'company',
      auth: hostedAuth(),
    });

    expect(result.isError).toBeUndefined();
    expect(parseToolJson(result).transport).toBe('oauth');
  });

  test('rejects unresolved hosted identity before the operation handler runs', async () => {
    await initCompanyBrain();

    const result = await dispatchToolCall(engine, 'whoami', {}, {
      remote: true,
      sourceId: 'company',
      auth: hostedAuth({ clientId: 'gbrain_cl_unknown', clientName: 'unknown-agent' }),
    });

    expect(result.isError).toBe(true);
    expect(parseToolJson(result)).toMatchObject({
      error: 'permission_denied',
      message: 'Company policy context is required for hosted company requests.',
    });
  });

  test('rejects ambiguous hosted identity before the operation handler runs', async () => {
    await initCompanyBrain();
    const raw = await engine.getConfig('company.policy.storage');
    const storage = JSON.parse(raw!);
    storage.users['company-duplicate'] = {
      id: 'company-duplicate',
      email: 'duplicate@example.invalid',
      idp_subjects: ['oauth-client:gbrain_cl_alice'],
      display_name: null,
      active: true,
    };
    await engine.setConfig('company.policy.storage', JSON.stringify(storage));

    const result = await dispatchToolCall(engine, 'whoami', {}, {
      remote: true,
      sourceId: 'company',
      auth: hostedAuth(),
    });

    expect(result.isError).toBe(true);
    expect(parseToolJson(result).error).toBe('permission_denied');
  });

  test('rejects missing and malformed policy config for hosted company requests', async () => {
    await applyCompanyModeSkeleton(engine);

    const missing = await dispatchToolCall(engine, 'whoami', {}, {
      remote: true,
      sourceId: 'company',
      auth: hostedAuth(),
    });
    expect(missing.isError).toBe(true);
    expect(parseToolJson(missing).error).toBe('permission_denied');

    const seed = companySeed();
    const storage = buildCompanyPolicyStorage(seed);
    const metadata = buildCompanyPolicyMetadata(seed);
    await engine.setConfig('company.policy.storage', JSON.stringify({ ...storage, policies: {} }));
    await engine.setConfig('company.policy.metadata', JSON.stringify(metadata));

    const malformed = await dispatchToolCall(engine, 'whoami', {}, {
      remote: true,
      sourceId: 'company',
      auth: hostedAuth(),
    });
    expect(malformed.isError).toBe(true);
    expect(parseToolJson(malformed).error).toBe('permission_denied');
  });

  test('allows source overrides only when they narrow to an allowed existing source', async () => {
    await initCompanyBrain();
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $2, '{}'::jsonb)`,
      ['shared', 'shared'],
    );

    const allowed = await dispatchToolCall(engine, 'whoami', { source_id: 'shared' }, {
      remote: true,
      sourceId: 'company',
      auth: hostedAuth({ allowedSources: ['company', 'shared'] }),
    });
    expect(allowed.isError).toBeUndefined();

    const disallowed = await dispatchToolCall(engine, 'whoami', { source_id: 'secret' }, {
      remote: true,
      sourceId: 'company',
      auth: hostedAuth({ allowedSources: ['company', 'shared'] }),
    });
    expect(disallowed.isError).toBe(true);
    expect(parseToolJson(disallowed).error).toBe('permission_denied');

    const allSources = await dispatchToolCall(engine, 'whoami', { source_id: '__all__' }, {
      remote: true,
      sourceId: 'company',
      auth: hostedAuth({ allowedSources: ['company', 'shared'] }),
    });
    expect(allSources.isError).toBe(true);
    expect(parseToolJson(allSources).error).toBe('permission_denied');

    const allowedSourcesNarrowing = await dispatchToolCall(engine, 'whoami', { allowedSources: ['shared'] }, {
      remote: true,
      sourceId: 'company',
      auth: hostedAuth({ allowedSources: ['company', 'shared'] }),
    });
    expect(allowedSourcesNarrowing.isError).toBeUndefined();

    const disallowedSourcesNarrowing = await dispatchToolCall(engine, 'whoami', { allowedSources: ['secret'] }, {
      remote: true,
      sourceId: 'company',
      auth: hostedAuth({ allowedSources: ['company', 'shared'] }),
    });
    expect(disallowedSourcesNarrowing.isError).toBe(true);
    expect(parseToolJson(disallowedSourcesNarrowing).error).toBe('permission_denied');
  });

  test('rejects hosted company contexts with missing source scope', async () => {
    await initCompanyBrain();

    const result = await dispatchToolCall(engine, 'whoami', {}, {
      remote: true,
      sourceId: 'missing-source',
      auth: hostedAuth({
        sourceId: 'missing-source',
        allowedSources: ['missing-source'],
      }),
    });

    expect(result.isError).toBe(true);
    expect(parseToolJson(result).error).toBe('permission_denied');
  });

  test('leaves trusted local CLI behavior outside the hosted gate', async () => {
    await applyCompanyModeSkeleton(engine);

    const result = await dispatchToolCall(engine, 'whoami', {}, {
      remote: false,
      sourceId: 'company',
    });

    expect(result.isError).toBeUndefined();
    expect(parseToolJson(result)).toEqual({ transport: 'local', scopes: [] });
  });

  test('rejects stdio-style remote company requests without auth before the handler runs', async () => {
    await initCompanyBrain();

    const result = await dispatchToolCall(engine, 'whoami', {}, {
      remote: true,
      sourceId: 'company',
    });

    expect(result.isError).toBe(true);
    expect(parseToolJson(result)).toMatchObject({
      error: 'permission_denied',
      message: 'Company policy context is required for hosted company requests.',
    });
  });

  test('reports non-company remote requests as not gated for operator workflows', async () => {
    await applyCompanyModeSkeleton(engine);
    await engine.setConfig('brain.mode', 'personal');
    await engine.setConfig('company.mode', 'disabled');
    await engine.setConfig('company.trusted_workspace', 'false');
    const ctx = buildOperationContext(engine, {}, {
      remote: true,
      sourceId: 'company',
    });

    const result = await evaluateHostedCompanyRequestGate(ctx, {});

    expect(result).toEqual({
      gated: false,
      allowed: true,
      reason: 'not_hosted_company_request',
    });
  });
});
