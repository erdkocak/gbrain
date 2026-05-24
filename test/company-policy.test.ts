import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { COMPANY_DEFAULT_POLICY_ID, COMPANY_OBJECT_TYPES } from '../src/core/company-layout.ts';
import {
  applyCompanyPolicySeed,
  buildCompanyPolicyMetadata,
  buildCompanyPolicyStorage,
  buildDefaultCompanyPolicySeed,
  CompanyPolicySeedError,
  COMPANY_POLICY_DEFAULT_DECISION,
  COMPANY_POLICY_ENFORCEMENT_STATUS,
  parseCompanyPolicySeedYaml,
} from '../src/core/company-policy.ts';

describe('company policy storage seed', () => {
  test('default seed is compatible with the trusted-workspace policy id', () => {
    const seed = buildDefaultCompanyPolicySeed();
    const storage = buildCompanyPolicyStorage(seed);
    const metadata = buildCompanyPolicyMetadata(seed);

    expect(seed.policies.map((policy) => policy.id)).toContain(COMPANY_DEFAULT_POLICY_ID);
    expect(seed.path_defaults).toHaveLength(COMPANY_OBJECT_TYPES.length);
    expect(seed.path_defaults.every((entry) => entry.visibility_policy_id === COMPANY_DEFAULT_POLICY_ID)).toBe(true);
    expect(seed.egress.external_model).toBe('disabled_by_default');
    expect(seed.egress.external_web).toBe('disabled_by_default');

    expect(storage.enforcement).toBe(COMPANY_POLICY_ENFORCEMENT_STATUS);
    expect(storage.default_decision).toBe(COMPANY_POLICY_DEFAULT_DECISION);
    expect(storage.default_policy_id).toBe(COMPANY_DEFAULT_POLICY_ID);
    expect(storage.group_memberships).toEqual([
      { group_id: 'company-pilot-admins', user_id: 'company-pilot-user' },
    ]);
    expect(storage.grants).toEqual([
      { principal_type: 'group', principal_id: 'company-pilot-admins', policy_id: COMPANY_DEFAULT_POLICY_ID, permission: 'read' },
      { principal_type: 'group', principal_id: 'company-pilot-admins', policy_id: COMPANY_DEFAULT_POLICY_ID, permission: 'write' },
    ]);

    expect(metadata.enforcement).toBe(COMPANY_POLICY_ENFORCEMENT_STATUS);
    expect(metadata.default_decision).toBe(COMPANY_POLICY_DEFAULT_DECISION);
    expect(metadata.policy_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(metadata.policy_version).toMatch(/^company-policy-v1-[a-f0-9]{12}$/);
  });

  test('parses YAML seed shape and defaults missing grants to deny', () => {
    const seed = parseCompanyPolicySeedYaml(`
version: 1
users:
  - id: alice-example
    email: alice@example.invalid
groups:
  - id: company-pilot-admins
    members:
      - alice-example
policies:
  - id: company-trusted-workspace
    label: Trusted workspace
path_defaults:
  - object_type: meeting
    path_prefix: meetings/
    visibility_policy_id: company-trusted-workspace
egress:
  external_model: disabled_by_default
  external_web: disabled_by_default
audit:
  readers:
    groups:
      - company-pilot-admins
`);
    const storage = buildCompanyPolicyStorage(seed);

    expect(seed.users[0]?.id).toBe('alice-example');
    expect(seed.policies[0]?.read).toEqual({ users: [], groups: [] });
    expect(seed.policies[0]?.write).toEqual({ users: [], groups: [] });
    expect(storage.grants).toEqual([]);
    expect(storage.default_decision).toBe('deny');
    expect(storage.audit.readers.groups).toEqual(['company-pilot-admins']);
  });

  test('rejects unknown principals, unknown path policies, duplicate ids, and nested groups', () => {
    expect(() => parseCompanyPolicySeedYaml(`
version: 1
users:
  - id: alice-example
  - id: alice-example
groups:
  - id: company-pilot-admins
    members:
      - missing-user
    groups:
      - nested-group
policies:
  - id: company-trusted-workspace
    read:
      groups:
        - missing-group
path_defaults:
  - path_prefix: meetings/
    visibility_policy_id: missing-policy
audit:
  readers:
    users:
      - missing-user
`)).toThrow(CompanyPolicySeedError);
  });

  test('rejects duplicate user identity keys used by request-context mapping', () => {
    const duplicateCases = [
      {
        name: 'case-normalized email',
        userA: 'email: alice@example.invalid',
        userB: 'email: ALICE@example.invalid',
      },
      {
        name: 'IdP subject',
        userA: 'idp_subjects: [idp:alice-subject]',
        userB: 'idp_subjects: [idp:alice-subject]',
      },
      {
        name: 'OAuth client id alias',
        userA: 'idp_subjects: [oauth-client:gbrain_cl_shared]',
        userB: 'idp_subjects: [oauth-client:gbrain_cl_shared]',
      },
      {
        name: 'OAuth client name alias',
        userA: 'idp_subjects: [client-name:shared-agent]',
        userB: 'idp_subjects: [client-name:shared-agent]',
      },
    ];

    for (const entry of duplicateCases) {
      expect(() => parseCompanyPolicySeedYaml(`
version: 1
users:
  - id: alice-example
    ${entry.userA}
  - id: bob-example
    ${entry.userB}
groups:
  - id: company-pilot-admins
    members:
      - alice-example
policies:
  - id: company-trusted-workspace
    read:
      groups:
        - company-pilot-admins
path_defaults:
  - path_prefix: meetings/
    visibility_policy_id: company-trusted-workspace
audit:
  readers:
    groups:
      - company-pilot-admins
`), entry.name).toThrow(CompanyPolicySeedError);
    }

    expect(() => parseCompanyPolicySeedYaml(`
version: 1
users:
  - id: alice-example
    idp_subjects:
      - idp:alice-subject
      - idp:alice-subject
groups:
  - id: company-pilot-admins
    members:
      - alice-example
policies:
  - id: company-trusted-workspace
    read:
      groups:
        - company-pilot-admins
path_defaults:
  - path_prefix: meetings/
    visibility_policy_id: company-trusted-workspace
audit:
  readers:
    groups:
      - company-pilot-admins
`), 'duplicate subject in one user').toThrow(CompanyPolicySeedError);
  });

  test('applies policy seed into config-backed durable storage without enforcement claims', async () => {
    const configSet: Record<string, string> = {};
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const engine = {
      setConfig: async (key: string, value: string) => {
        configSet[key] = value;
      },
      executeRaw: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return [];
      },
    } as unknown as BrainEngine;

    const result = await applyCompanyPolicySeed(engine);

    expect(JSON.parse(configSet['company.policy']!).metadata.enforcement).toBe(COMPANY_POLICY_ENFORCEMENT_STATUS);
    expect(JSON.parse(configSet['company.policy.seed']!).policies[0].id).toBe(COMPANY_DEFAULT_POLICY_ID);
    expect(JSON.parse(configSet['company.policy.storage']!).default_decision).toBe('deny');
    expect(JSON.parse(configSet['company.policy.metadata']!).enforcement).toBe(COMPANY_POLICY_ENFORCEMENT_STATUS);
    expect(configSet['company.policy.default_policy_id']).toBe(COMPANY_DEFAULT_POLICY_ID);
    expect(configSet['company.policy.default_decision']).toBe('deny');
    expect(configSet['company.policy.enforcement']).toBe(COMPANY_POLICY_ENFORCEMENT_STATUS);
    expect(configSet['company.policy.version']).toBe(result.metadata.policy_version);
    expect(configSet['company.policy.hash']).toBe(result.metadata.policy_hash);

    const sourceUpdate = calls.find((call) => call.sql.includes('UPDATE sources'));
    expect(sourceUpdate).toBeDefined();
    expect(sourceUpdate?.params[1]).toBe('company');
    expect(JSON.parse(sourceUpdate?.params[0] as string).company_policy_enforcement).toBe(COMPANY_POLICY_ENFORCEMENT_STATUS);
  });
});
