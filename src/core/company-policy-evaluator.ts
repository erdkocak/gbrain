import { createHash } from 'node:crypto';
import {
  COMPANY_POLICY_DEFAULT_DECISION,
  COMPANY_POLICY_ENFORCEMENT_STAGE,
  type CompanyPolicyMetadata,
  type CompanyPolicyPermission,
  type CompanyPolicyStorage,
} from './company-policy.ts';
import { COMPANY_DEFAULT_POLICY_ID } from './company-layout.ts';

export const COMPANY_POLICY_EVALUATOR_STAGE = 'stage_2b_resolved_not_enforced';
export const COMPANY_POLICY_NESTED_GROUP_BEHAVIOR = 'rejected_by_seed_validator_stage_2a';

export type CompanyPolicyDecision = 'allow' | 'deny';
export type CompanyDerivedVisibilityDecision = 'inherit' | 'intersect' | 'reject';

export class CompanyPolicyEvaluationError extends Error {
  constructor(
    public code: 'invalid_storage' | 'nested_groups_not_supported',
    message: string,
    public issues: string[] = [],
  ) {
    super(message);
    this.name = 'CompanyPolicyEvaluationError';
  }
}

export interface CompanyPolicyResolverMetadata {
  policy_version: string;
  policy_hash: string;
  schema_version: CompanyPolicyStorage['schema_version'];
  default_policy_id: typeof COMPANY_DEFAULT_POLICY_ID;
  default_decision: typeof COMPANY_POLICY_DEFAULT_DECISION;
  enforcement: typeof COMPANY_POLICY_ENFORCEMENT_STAGE;
  evaluator_stage: typeof COMPANY_POLICY_EVALUATOR_STAGE;
}

export interface CompanyPolicyDecisionSet {
  read: CompanyPolicyDecision;
  write: CompanyPolicyDecision;
}

export interface CompanyPolicyUserEvaluation extends CompanyPolicyResolverMetadata {
  user_id: string | null;
  known_user: boolean;
  active_user: boolean;
  group_ids: string[];
  readable_policy_ids: string[];
  writable_policy_ids: string[];
  policy_decisions: Record<string, CompanyPolicyDecisionSet>;
  nested_group_behavior: typeof COMPANY_POLICY_NESTED_GROUP_BEHAVIOR;
}

export interface CompanyDerivedVisibilityResolution {
  evaluator_stage: typeof COMPANY_POLICY_EVALUATOR_STAGE;
  decision: CompanyDerivedVisibilityDecision;
  reason: 'single_input_inherits' | 'multiple_inputs_intersect' | 'no_inputs' | 'no_input_policies' | 'empty_intersection';
  input_count: number;
  visibility_policy_ids: string[];
}

export function evaluateCompanyPolicyForUser(
  storage: CompanyPolicyStorage,
  userId: string | null | undefined,
  metadata?: CompanyPolicyMetadata,
): CompanyPolicyUserEvaluation {
  validateStorageForEvaluation(storage);

  const normalizedUserId = userId?.trim() || null;
  const user = normalizedUserId ? storage.users[normalizedUserId] : undefined;
  const knownUser = Boolean(user);
  const activeUser = Boolean(user?.active);
  const groupIds = activeUser && normalizedUserId ? expandCompanyPolicyGroups(storage, normalizedUserId) : [];
  const policyIds = Object.keys(storage.policies).sort();
  const policyDecisions: Record<string, CompanyPolicyDecisionSet> = {};
  const readablePolicyIds: string[] = [];
  const writablePolicyIds: string[] = [];

  for (const policyId of policyIds) {
    const read = activeUser && normalizedUserId
      ? resolvePolicyPermission(storage, normalizedUserId, groupIds, policyId, 'read')
      : 'deny';
    const write = activeUser && normalizedUserId
      ? resolvePolicyPermission(storage, normalizedUserId, groupIds, policyId, 'write')
      : 'deny';
    policyDecisions[policyId] = { read, write };
    if (read === 'allow') readablePolicyIds.push(policyId);
    if (write === 'allow') writablePolicyIds.push(policyId);
  }

  return {
    ...buildCompanyPolicyResolverMetadata(storage, metadata),
    user_id: normalizedUserId,
    known_user: knownUser,
    active_user: activeUser,
    group_ids: groupIds,
    readable_policy_ids: readablePolicyIds,
    writable_policy_ids: writablePolicyIds,
    policy_decisions: policyDecisions,
    nested_group_behavior: COMPANY_POLICY_NESTED_GROUP_BEHAVIOR,
  };
}

export function expandCompanyPolicyGroups(storage: CompanyPolicyStorage, userId: string): string[] {
  validateStorageForEvaluation(storage);
  if (!storage.users[userId]?.active) return [];
  return uniqueSorted(storage.group_memberships
    .filter((membership) => membership.user_id === userId)
    .map((membership) => membership.group_id));
}

export function buildCompanyPolicyResolverMetadata(
  storage: CompanyPolicyStorage,
  metadata?: CompanyPolicyMetadata,
): CompanyPolicyResolverMetadata {
  const policyHash = metadata?.policy_hash ?? stableSha256({
    schema_version: storage.schema_version,
    users: storage.users,
    groups: storage.groups,
    group_memberships: storage.group_memberships,
    policies: storage.policies,
    grants: storage.grants,
    path_defaults: storage.path_defaults,
    egress: storage.egress,
    audit: storage.audit,
  });

  return {
    policy_version: metadata?.policy_version ?? `stage-2b-storage-v${storage.schema_version}-${policyHash.slice(0, 12)}`,
    policy_hash: policyHash,
    schema_version: storage.schema_version,
    default_policy_id: COMPANY_DEFAULT_POLICY_ID,
    default_decision: COMPANY_POLICY_DEFAULT_DECISION,
    enforcement: COMPANY_POLICY_ENFORCEMENT_STAGE,
    evaluator_stage: COMPANY_POLICY_EVALUATOR_STAGE,
  };
}

export function resolveCompanyDerivedVisibility(
  inputPolicySets: ReadonlyArray<readonly string[]>,
): CompanyDerivedVisibilityResolution {
  if (inputPolicySets.length === 0) {
    return derivedVisibilityResolution('reject', 'no_inputs', 0, []);
  }

  const normalizedSets = inputPolicySets.map((set) => uniqueSorted(set.map((policyId) => policyId.trim()).filter(Boolean)));
  if (normalizedSets.some((set) => set.length === 0)) {
    return derivedVisibilityResolution('reject', 'no_input_policies', inputPolicySets.length, []);
  }

  if (normalizedSets.length === 1) {
    return derivedVisibilityResolution('inherit', 'single_input_inherits', 1, normalizedSets[0]!);
  }

  let intersection = normalizedSets[0]!;
  for (const set of normalizedSets.slice(1)) {
    const next = new Set(set);
    intersection = intersection.filter((policyId) => next.has(policyId));
  }

  if (intersection.length === 0) {
    return derivedVisibilityResolution('reject', 'empty_intersection', inputPolicySets.length, []);
  }

  return derivedVisibilityResolution('intersect', 'multiple_inputs_intersect', inputPolicySets.length, intersection);
}

function resolvePolicyPermission(
  storage: CompanyPolicyStorage,
  userId: string,
  groupIds: string[],
  policyId: string,
  permission: CompanyPolicyPermission,
): CompanyPolicyDecision {
  const groupIdSet = new Set(groupIds);
  for (const grant of storage.grants) {
    if (grant.policy_id !== policyId || grant.permission !== permission) continue;
    if (grant.principal_type === 'user' && grant.principal_id === userId) return 'allow';
    if (grant.principal_type === 'group' && groupIdSet.has(grant.principal_id)) return 'allow';
  }
  return 'deny';
}

function validateStorageForEvaluation(storage: CompanyPolicyStorage): void {
  const issues: string[] = [];
  const nestedGroups: string[] = [];
  const userIds = new Set(Object.keys(storage.users));
  const groupIds = new Set(Object.keys(storage.groups));
  const policyIds = new Set(Object.keys(storage.policies));

  for (const [groupId, group] of Object.entries(storage.groups)) {
    if (Object.prototype.hasOwnProperty.call(group as object, 'groups')) {
      nestedGroups.push(groupId);
    }
  }

  if (nestedGroups.length > 0) {
    throw new CompanyPolicyEvaluationError(
      'nested_groups_not_supported',
      `Nested groups are not supported in Stage 2B policy evaluation: ${nestedGroups.join(', ')}`,
      nestedGroups.map((groupId) => `groups.${groupId}.groups is not supported`),
    );
  }

  for (const membership of storage.group_memberships) {
    if (!groupIds.has(membership.group_id)) issues.push(`group_memberships references unknown group "${membership.group_id}"`);
    if (!userIds.has(membership.user_id)) issues.push(`group_memberships references unknown user "${membership.user_id}"`);
  }

  for (const grant of storage.grants) {
    if (!policyIds.has(grant.policy_id)) issues.push(`grants references unknown policy "${grant.policy_id}"`);
    if (grant.permission !== 'read' && grant.permission !== 'write') {
      issues.push(`grants contains unsupported permission "${String(grant.permission)}"`);
    }
    if (grant.principal_type !== 'user' && grant.principal_type !== 'group') {
      issues.push(`grants contains unsupported principal_type "${String(grant.principal_type)}"`);
      continue;
    }
    if (grant.principal_type === 'user' && !userIds.has(grant.principal_id)) {
      issues.push(`grants references unknown user "${grant.principal_id}"`);
    }
    if (grant.principal_type === 'group' && !groupIds.has(grant.principal_id)) {
      issues.push(`grants references unknown group "${grant.principal_id}"`);
    }
  }

  if (!policyIds.has(COMPANY_DEFAULT_POLICY_ID)) {
    issues.push(`policies must include default policy "${COMPANY_DEFAULT_POLICY_ID}"`);
  }

  if (issues.length > 0) {
    throw new CompanyPolicyEvaluationError(
      'invalid_storage',
      `Invalid company policy storage: ${issues.join('; ')}`,
      issues,
    );
  }
}

function derivedVisibilityResolution(
  decision: CompanyDerivedVisibilityDecision,
  reason: CompanyDerivedVisibilityResolution['reason'],
  inputCount: number,
  visibilityPolicyIds: string[],
): CompanyDerivedVisibilityResolution {
  return {
    evaluator_stage: COMPANY_POLICY_EVALUATOR_STAGE,
    decision,
    reason,
    input_count: inputCount,
    visibility_policy_ids: visibilityPolicyIds,
  };
}

function uniqueSorted(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function stableSha256(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
