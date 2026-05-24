import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { AuthInfo, OperationContext } from '../src/core/operations.ts';
import {
  type CompanyPolicyStorage,
  buildCompanyPolicyMetadata,
  buildCompanyPolicyStorage,
  parseCompanyPolicySeedYaml,
} from '../src/core/company-policy.ts';
import {
  buildCompanyRequestContext,
  buildCompanyRequestContextFromOperationContext,
  COMPANY_REQUEST_CONTEXT_ENFORCEMENT,
  COMPANY_REQUEST_CONTEXT_STAGE,
  loadCompanyPolicyConfigSnapshot,
  resolveCompanyIdentity,
} from '../src/core/company-request-context.ts';

function fixtureSeed() {
  return parseCompanyPolicySeedYaml(`
version: 1
users:
  - id: alice-example
    email: alice@example.invalid
    idp_subjects:
      - idp:alice-subject
  - id: bob-example
    email: bob@example.invalid
    idp_subjects:
      - oauth-client:gbrain_cl_bob
      - client-name:bob-agent
groups:
  - id: company-pilot-admins
    members:
      - alice-example
  - id: engineering
    members:
      - bob-example
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
path_defaults:
  - path_prefix: meetings/
    visibility_policy_id: company-trusted-workspace
audit:
  readers:
    groups:
      - company-pilot-admins
`);
}

function fixturePolicy() {
  const seed = fixtureSeed();
  return {
    seed,
    storage: buildCompanyPolicyStorage(seed),
    metadata: buildCompanyPolicyMetadata(seed),
  };
}

function makeCtx(engine: BrainEngine, overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: {} as any,
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: true,
    sourceId: 'company',
    ...overrides,
  } as OperationContext;
}

describe('company identity mapping', () => {
  test('maps IdP subject, email, and OAuth client identity to canonical user id', () => {
    const { storage } = fixturePolicy();

    expect(resolveCompanyIdentity(storage, { idpSubject: 'idp:alice-subject' })).toMatchObject({
      status: 'resolved',
      source: 'idp_subject',
      userId: 'alice-example',
      email: 'alice@example.invalid',
      idpSubject: 'idp:alice-subject',
    });

    expect(resolveCompanyIdentity(storage, { email: 'BOB@example.invalid' })).toMatchObject({
      status: 'resolved',
      source: 'email',
      userId: 'bob-example',
    });

    expect(resolveCompanyIdentity(storage, { clientId: 'gbrain_cl_bob' })).toMatchObject({
      status: 'resolved',
      source: 'oauth_client_id',
      userId: 'bob-example',
      idpSubject: 'oauth-client:gbrain_cl_bob',
    });

    expect(resolveCompanyIdentity(storage, { clientName: 'bob-agent' })).toMatchObject({
      status: 'resolved',
      source: 'oauth_client_name',
      userId: 'bob-example',
      idpSubject: 'client-name:bob-agent',
    });

    expect(resolveCompanyIdentity(storage, { clientId: 'unknown-client' })).toMatchObject({
      status: 'unresolved',
      source: 'none',
      userId: null,
    });
  });

  test('ambiguous request-time identity mappings resolve without user grants', () => {
    const { storage } = fixturePolicy();
    const ambiguousEmailStorage = {
      ...storage,
      users: {
        ...storage.users,
        'duplicate-example': {
          id: 'duplicate-example',
          email: 'ALICE@example.invalid',
          idp_subjects: ['idp:alice-subject', 'oauth-client:gbrain_cl_bob', 'client-name:bob-agent'],
          active: true,
        },
      },
    } as CompanyPolicyStorage;

    expect(resolveCompanyIdentity(ambiguousEmailStorage, { email: 'alice@example.invalid' })).toMatchObject({
      status: 'ambiguous',
      source: 'email',
      userId: null,
    });
    expect(resolveCompanyIdentity(ambiguousEmailStorage, { idpSubject: 'idp:alice-subject' })).toMatchObject({
      status: 'ambiguous',
      source: 'idp_subject',
      userId: null,
    });
    expect(resolveCompanyIdentity(ambiguousEmailStorage, { clientId: 'gbrain_cl_bob' })).toMatchObject({
      status: 'ambiguous',
      source: 'oauth_client_id',
      userId: null,
    });
    expect(resolveCompanyIdentity(ambiguousEmailStorage, { clientName: 'bob-agent' })).toMatchObject({
      status: 'ambiguous',
      source: 'oauth_client_name',
      userId: null,
    });

    const ctx = buildCompanyRequestContext({
      requestId: 'ambiguous-identity',
      sourceId: 'company',
      remote: true,
      identity: { email: 'alice@example.invalid' },
      storage: ambiguousEmailStorage,
    });
    expect(ctx.identityStatus).toBe('ambiguous');
    expect(ctx.userId).toBeNull();
    expect(ctx.readablePolicyIds).toEqual([]);
    expect(ctx.writablePolicyIds).toEqual([]);
  });
});

describe('company request context', () => {
  test('builds hosted OAuth context with policy outputs and source routing kept separate', () => {
    const { storage, metadata } = fixturePolicy();
    const auth: AuthInfo = {
      token: 'gbrain_at_test',
      clientId: 'gbrain_cl_bob',
      clientName: 'bob-agent',
      scopes: ['write', 'read'],
      sourceId: 'company',
      allowedSources: ['shared', 'company'],
      expiresAt: 123,
    };

    const ctx = buildCompanyRequestContext({
      requestId: 'req-stage-2c',
      brainId: 'host',
      sourceId: 'company',
      allowedSources: auth.allowedSources,
      remote: true,
      auth,
      storage,
      metadata,
      trustedWorkspace: true,
      sessionId: 'session-1',
      legacyTakesHoldersAllowList: ['world'],
    });

    expect(ctx.stage).toBe(COMPANY_REQUEST_CONTEXT_STAGE);
    expect(ctx.enforcement).toBe(COMPANY_REQUEST_CONTEXT_ENFORCEMENT);
    expect(ctx.transport).toBe('hosted_mcp_oauth');
    expect(ctx.userId).toBe('bob-example');
    expect(ctx.identitySource).toBe('oauth_client_id');
    expect(ctx.groupIds).toEqual(['engineering']);
    expect(ctx.readablePolicyIds).toEqual(['engineering-notes']);
    expect(ctx.writablePolicyIds).toEqual([]);
    expect(ctx.policyVersion).toBe(metadata.policy_version);
    expect(ctx.policyHash).toBe(metadata.policy_hash);
    expect(ctx.policyDecisionId).toMatch(/^cpd_[a-f0-9]{16}$/);
    expect(ctx.allowedSources).toEqual(['company', 'shared']);
    expect(ctx.sourceRouting).toEqual({
      sourceId: 'company',
      allowedSources: ['company', 'shared'],
      independentOfPolicyGrants: true,
    });
    expect(ctx.legacyTakesHoldersAllowList).toEqual(['world']);
    expect(ctx.sessionId).toBe('session-1');
    expect(ctx.trustedWorkspace).toBe(true);
    expect(ctx.policyContextAvailable).toBe(true);
  });

  test('represents local CLI and stdio MCP behavior without implying enforcement', () => {
    const { storage, metadata } = fixturePolicy();

    const local = buildCompanyRequestContext({
      requestId: 'local-req',
      sourceId: 'company',
      remote: false,
      storage,
      metadata,
      trustedWorkspace: true,
    });
    expect(local.transport).toBe('local_cli');
    expect(local.identityStatus).toBe('trusted_local');
    expect(local.userId).toBeNull();
    expect(local.remote).toBe(false);
    expect(local.enforcement).toBe('not_enforced_stage_2c');
    expect(local.readablePolicyIds).toEqual([]);

    const stdio = buildCompanyRequestContext({
      requestId: 'stdio-req',
      sourceId: 'company',
      remote: true,
      storage,
      metadata,
      trustedWorkspace: true,
      legacyTakesHoldersAllowList: ['world'],
    });
    expect(stdio.transport).toBe('stdio_mcp');
    expect(stdio.identityStatus).toBe('unresolved');
    expect(stdio.userId).toBeNull();
    expect(stdio.remote).toBe(true);
    expect(stdio.legacyTakesHoldersAllowList).toEqual(['world']);
    expect(stdio.readablePolicyIds).toEqual([]);
    expect(stdio.writablePolicyIds).toEqual([]);
  });

  test('loads policy config and constructs context from OperationContext', async () => {
    const { storage, metadata } = fixturePolicy();
    const config: Record<string, string> = {
      'company.policy.storage': JSON.stringify(storage),
      'company.policy.metadata': JSON.stringify(metadata),
      'company.trusted_workspace': 'true',
    };
    const engine = {
      getConfig: async (key: string) => config[key] ?? null,
    } as unknown as BrainEngine;
    const auth: AuthInfo = {
      token: 'gbrain_at_test',
      clientId: 'gbrain_cl_bob',
      clientName: 'bob-agent',
      scopes: ['read'],
      sourceId: 'company',
      allowedSources: ['company', 'shared'],
    };

    const snapshot = await loadCompanyPolicyConfigSnapshot(engine);
    expect(snapshot?.trustedWorkspace).toBe(true);
    expect(snapshot?.metadata?.policy_hash).toBe(metadata.policy_hash);

    const requestContext = await buildCompanyRequestContextFromOperationContext(
      makeCtx(engine, {
        auth,
        remote: true,
        sourceId: 'company',
        brainId: 'host',
        takesHoldersAllowList: ['world'],
        jobId: 10,
        subagentId: 20,
        viaSubagent: true,
      }),
      { session_id: 'session-from-params' },
      { requestId: 'req-from-op' },
    );

    expect(requestContext).toBeDefined();
    expect(requestContext?.transport).toBe('subagent');
    expect(requestContext?.userId).toBe('bob-example');
    expect(requestContext?.allowedSources).toEqual(['company', 'shared']);
    expect(requestContext?.sessionId).toBe('session-from-params');
    expect(requestContext?.jobContext).toEqual({ jobId: 10, subagentId: 20, viaSubagent: true });
    expect(requestContext?.legacyTakesHoldersAllowList).toEqual(['world']);
  });

  test('source routing is independent from policy grants', () => {
    const { storage, metadata } = fixturePolicy();
    const ctx = buildCompanyRequestContext({
      requestId: 'routing-req',
      sourceId: 'alpha-source',
      allowedSources: ['beta-source', 'alpha-source'],
      remote: true,
      identity: { email: 'bob@example.invalid' },
      storage,
      metadata,
    });

    expect(ctx.userId).toBe('bob-example');
    expect(ctx.readablePolicyIds).toEqual(['engineering-notes']);
    expect(ctx.writablePolicyIds).toEqual([]);
    expect(ctx.sourceId).toBe('alpha-source');
    expect(ctx.allowedSources).toEqual(['alpha-source', 'beta-source']);
    expect(ctx.sourceRouting.independentOfPolicyGrants).toBe(true);
  });

  test('malformed policy storage produces unavailable context instead of throwing', () => {
    const ctx = buildCompanyRequestContext({
      requestId: 'malformed-storage',
      sourceId: 'company',
      remote: true,
      identity: { email: 'alice@example.invalid' },
      storage: { policies: {} } as any,
    });

    expect(ctx.policyContextAvailable).toBe(false);
    expect(ctx.identityStatus).toBe('unresolved');
    expect(ctx.policyContextError).toBeTruthy();
    expect(ctx.readablePolicyIds).toEqual([]);
    expect(ctx.writablePolicyIds).toEqual([]);
    expect(ctx.enforcement).toBe('not_enforced_stage_2c');
  });
});
