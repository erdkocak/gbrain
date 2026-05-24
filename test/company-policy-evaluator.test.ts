import { describe, expect, test } from 'bun:test';
import {
  buildCompanyPolicyMetadata,
  buildCompanyPolicyStorage,
  type CompanyPolicyStorage,
  parseCompanyPolicySeedYaml,
} from '../src/core/company-policy.ts';
import {
  buildCompanyPolicyResolverMetadata,
  COMPANY_POLICY_EVALUATOR_KIND,
  COMPANY_POLICY_NESTED_GROUP_BEHAVIOR,
  CompanyPolicyEvaluationError,
  evaluateCompanyPolicyForUser,
  expandCompanyPolicyGroups,
  resolveCompanyDerivedVisibility,
} from '../src/core/company-policy-evaluator.ts';

function fixtureSeed() {
  return parseCompanyPolicySeedYaml(`
version: 1
users:
  - id: alice-example
    email: alice@example.invalid
  - id: bob-example
    email: bob@example.invalid
  - id: inactive-example
    active: false
groups:
  - id: company-pilot-admins
    members:
      - alice-example
      - inactive-example
  - id: engineering
    members:
      - alice-example
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
    write:
      users:
        - alice-example
  - id: read-only-announcement
    read:
      users:
        - bob-example
  - id: write-only-draft
    write:
      groups:
        - engineering
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
}

describe('company policy evaluator', () => {
  test('expands direct group membership and keeps nested groups rejected', () => {
    const storage = buildCompanyPolicyStorage(fixtureSeed());

    expect(expandCompanyPolicyGroups(storage, 'alice-example')).toEqual(['company-pilot-admins', 'engineering']);
    expect(expandCompanyPolicyGroups(storage, 'bob-example')).toEqual(['engineering']);
    expect(expandCompanyPolicyGroups(storage, 'inactive-example')).toEqual([]);

    const nestedStorage = {
      ...storage,
      groups: {
        ...storage.groups,
        engineering: {
          ...storage.groups.engineering!,
          groups: ['company-pilot-admins'],
        },
      },
    } as unknown as CompanyPolicyStorage;

    expect(() => evaluateCompanyPolicyForUser(nestedStorage, 'alice-example')).toThrow(CompanyPolicyEvaluationError);
  });

  test('resolves read and write grants separately with default deny', () => {
    const seed = fixtureSeed();
    const storage = buildCompanyPolicyStorage(seed);
    const metadata = buildCompanyPolicyMetadata(seed);

    const alice = evaluateCompanyPolicyForUser(storage, 'alice-example', metadata);
    expect(alice.evaluator_kind).toBe(COMPANY_POLICY_EVALUATOR_KIND);
    expect(alice.nested_group_behavior).toBe(COMPANY_POLICY_NESTED_GROUP_BEHAVIOR);
    expect(alice.group_ids).toEqual(['company-pilot-admins', 'engineering']);
    expect(alice.readable_policy_ids).toEqual(['company-trusted-workspace', 'engineering-notes']);
    expect(alice.writable_policy_ids).toEqual(['company-trusted-workspace', 'engineering-notes', 'write-only-draft']);
    expect(alice.policy_decisions['read-only-announcement']).toEqual({ read: 'deny', write: 'deny' });
    expect(alice.policy_decisions['write-only-draft']).toEqual({ read: 'deny', write: 'allow' });

    const bob = evaluateCompanyPolicyForUser(storage, 'bob-example', metadata);
    expect(bob.group_ids).toEqual(['engineering']);
    expect(bob.readable_policy_ids).toEqual(['engineering-notes', 'read-only-announcement']);
    expect(bob.writable_policy_ids).toEqual(['write-only-draft']);
    expect(bob.policy_decisions['company-trusted-workspace']).toEqual({ read: 'deny', write: 'deny' });

    const unknown = evaluateCompanyPolicyForUser(storage, 'unknown-example', metadata);
    expect(unknown.known_user).toBe(false);
    expect(unknown.active_user).toBe(false);
    expect(unknown.group_ids).toEqual([]);
    expect(unknown.readable_policy_ids).toEqual([]);
    expect(unknown.writable_policy_ids).toEqual([]);
    expect(unknown.policy_decisions['company-trusted-workspace']).toEqual({ read: 'deny', write: 'deny' });

    const inactive = evaluateCompanyPolicyForUser(storage, 'inactive-example', metadata);
    expect(inactive.known_user).toBe(true);
    expect(inactive.active_user).toBe(false);
    expect(inactive.group_ids).toEqual([]);
    expect(inactive.readable_policy_ids).toEqual([]);
    expect(inactive.writable_policy_ids).toEqual([]);
  });

  test('returns stable policy version and hash metadata for request context', () => {
    const seed = fixtureSeed();
    const storage = buildCompanyPolicyStorage(seed);
    const metadata = buildCompanyPolicyMetadata(seed);
    const evaluation = evaluateCompanyPolicyForUser(storage, 'alice-example', metadata);

    expect(evaluation.policy_version).toBe(metadata.policy_version);
    expect(evaluation.policy_hash).toBe(metadata.policy_hash);
    expect(evaluation.policy_hash).toMatch(/^[a-f0-9]{64}$/);

    const fallback = buildCompanyPolicyResolverMetadata(storage);
    expect(fallback.policy_version).toMatch(/^company-policy-storage-v1-[a-f0-9]{12}$/);
    expect(fallback.policy_hash).toMatch(/^[a-f0-9]{64}$/);

    const changedSeed = parseCompanyPolicySeedYaml(`
version: 1
users:
  - id: alice-example
groups:
  - id: company-pilot-admins
    members:
      - alice-example
policies:
  - id: company-trusted-workspace
    read:
      users:
        - alice-example
path_defaults:
  - path_prefix: meetings/
    visibility_policy_id: company-trusted-workspace
audit:
  readers:
    users:
      - alice-example
`);
    expect(buildCompanyPolicyMetadata(changedSeed).policy_hash).not.toBe(metadata.policy_hash);
  });

  test('resolves derived visibility by inheritance, intersection, and rejection', () => {
    expect(resolveCompanyDerivedVisibility([['company-trusted-workspace']])).toEqual({
      evaluator_kind: COMPANY_POLICY_EVALUATOR_KIND,
      decision: 'inherit',
      reason: 'single_input_inherits',
      input_count: 1,
      visibility_policy_ids: ['company-trusted-workspace'],
    });

    expect(resolveCompanyDerivedVisibility([
      ['company-trusted-workspace', 'engineering-notes'],
      ['engineering-notes', 'read-only-announcement'],
      ['engineering-notes', 'write-only-draft'],
    ])).toEqual({
      evaluator_kind: COMPANY_POLICY_EVALUATOR_KIND,
      decision: 'intersect',
      reason: 'multiple_inputs_intersect',
      input_count: 3,
      visibility_policy_ids: ['engineering-notes'],
    });

    expect(resolveCompanyDerivedVisibility([
      ['company-trusted-workspace'],
      ['engineering-notes'],
    ])).toEqual({
      evaluator_kind: COMPANY_POLICY_EVALUATOR_KIND,
      decision: 'reject',
      reason: 'empty_intersection',
      input_count: 2,
      visibility_policy_ids: [],
    });

    expect(resolveCompanyDerivedVisibility([])).toEqual({
      evaluator_kind: COMPANY_POLICY_EVALUATOR_KIND,
      decision: 'reject',
      reason: 'no_inputs',
      input_count: 0,
      visibility_policy_ids: [],
    });
  });
});
