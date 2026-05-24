import { createHash } from 'node:crypto';
import { safeLoad as yamlSafeLoad } from 'js-yaml';
import type { BrainEngine } from './engine.ts';
import {
  COMPANY_DEFAULT_POLICY_ID,
  COMPANY_OBJECT_TYPES,
  type CompanyObjectType,
} from './company-layout.ts';
import { COMPANY_PRIMARY_SOURCE_ID } from './company-mode.ts';

export const COMPANY_POLICY_SCHEMA_VERSION = 1;
export const COMPANY_POLICY_STORAGE_KIND = 'company-policy-seed';
export const COMPANY_POLICY_ENFORCEMENT_STAGE = 'not_enforced_stage_2a';
export const COMPANY_POLICY_DEFAULT_DECISION = 'deny';

export type CompanyPolicyPermission = 'read' | 'write';
export type CompanyPolicyPrincipalType = 'user' | 'group';
export type CompanyPolicyEgressDecision = 'disabled_by_default' | 'allowed_by_policy';

export class CompanyPolicySeedError extends Error {
  constructor(
    public code: 'yaml_parse_error' | 'invalid_seed',
    message: string,
    public issues: string[] = [],
  ) {
    super(message);
    this.name = 'CompanyPolicySeedError';
  }
}

export interface CompanyPolicySeedUser {
  id: string;
  email?: string | null;
  idp_subjects: string[];
  display_name?: string | null;
  active: boolean;
}

export interface CompanyPolicySeedGroup {
  id: string;
  label?: string | null;
  members: string[];
}

export interface CompanyPolicyPrincipalSet {
  users: string[];
  groups: string[];
}

export interface CompanyPolicySeedPolicy {
  id: string;
  label?: string | null;
  description?: string | null;
  read: CompanyPolicyPrincipalSet;
  write: CompanyPolicyPrincipalSet;
}

export interface CompanyPolicyPathDefault {
  object_type?: CompanyObjectType;
  path_prefix: string;
  visibility_policy_id: string;
}

export interface CompanyPolicySeed {
  version: typeof COMPANY_POLICY_SCHEMA_VERSION;
  users: CompanyPolicySeedUser[];
  groups: CompanyPolicySeedGroup[];
  policies: CompanyPolicySeedPolicy[];
  path_defaults: CompanyPolicyPathDefault[];
  egress: {
    external_model: CompanyPolicyEgressDecision;
    external_web: CompanyPolicyEgressDecision;
  };
  audit: {
    readers: CompanyPolicyPrincipalSet;
  };
}

export interface CompanyPolicyGrant {
  principal_type: CompanyPolicyPrincipalType;
  principal_id: string;
  policy_id: string;
  permission: CompanyPolicyPermission;
}

export interface CompanyPolicyGroupMembership {
  group_id: string;
  user_id: string;
}

export interface CompanyPolicyStorage {
  schema_version: typeof COMPANY_POLICY_SCHEMA_VERSION;
  kind: typeof COMPANY_POLICY_STORAGE_KIND;
  enforcement: typeof COMPANY_POLICY_ENFORCEMENT_STAGE;
  default_decision: typeof COMPANY_POLICY_DEFAULT_DECISION;
  default_policy_id: typeof COMPANY_DEFAULT_POLICY_ID;
  users: Record<string, CompanyPolicySeedUser>;
  groups: Record<string, CompanyPolicySeedGroup>;
  group_memberships: CompanyPolicyGroupMembership[];
  policies: Record<string, Omit<CompanyPolicySeedPolicy, 'read' | 'write'>>;
  grants: CompanyPolicyGrant[];
  path_defaults: CompanyPolicyPathDefault[];
  egress: CompanyPolicySeed['egress'];
  audit: CompanyPolicySeed['audit'];
}

export interface CompanyPolicyMetadata {
  schema_version: typeof COMPANY_POLICY_SCHEMA_VERSION;
  kind: typeof COMPANY_POLICY_STORAGE_KIND;
  policy_version: string;
  policy_hash: string;
  enforcement: typeof COMPANY_POLICY_ENFORCEMENT_STAGE;
  default_decision: typeof COMPANY_POLICY_DEFAULT_DECISION;
  default_policy_id: typeof COMPANY_DEFAULT_POLICY_ID;
}

export interface CompanyPolicyApplyResult {
  seed: CompanyPolicySeed;
  storage: CompanyPolicyStorage;
  metadata: CompanyPolicyMetadata;
}

const ID_RE = /^[a-z][a-z0-9._-]{0,79}$/;
const EGRESS_VALUES = new Set<CompanyPolicyEgressDecision>(['disabled_by_default', 'allowed_by_policy']);

export function buildDefaultCompanyPolicySeed(): CompanyPolicySeed {
  return normalizeCompanyPolicySeed({
    version: COMPANY_POLICY_SCHEMA_VERSION,
    users: [{
      id: 'company-pilot-user',
      email: null,
      idp_subjects: [],
      display_name: 'Company pilot user',
      active: true,
    }],
    groups: [{
      id: 'company-pilot-admins',
      label: 'Company pilot admins',
      members: ['company-pilot-user'],
    }],
    policies: [{
      id: COMPANY_DEFAULT_POLICY_ID,
      label: 'Company trusted workspace default',
      description: 'Stage 2A representational policy for Stage 1 trusted company workspace artifacts.',
      read: { users: [], groups: ['company-pilot-admins'] },
      write: { users: [], groups: ['company-pilot-admins'] },
    }],
    path_defaults: COMPANY_OBJECT_TYPES.map((objectType) => ({
      object_type: objectType,
      path_prefix: `${pathPrefixForObjectType(objectType)}/`,
      visibility_policy_id: COMPANY_DEFAULT_POLICY_ID,
    })),
    egress: {
      external_model: 'disabled_by_default',
      external_web: 'disabled_by_default',
    },
    audit: {
      readers: { users: [], groups: ['company-pilot-admins'] },
    },
  });
}

export function parseCompanyPolicySeedYaml(content: string): CompanyPolicySeed {
  let raw: unknown;
  try {
    raw = yamlSafeLoad(content);
  } catch (e) {
    throw new CompanyPolicySeedError(
      'yaml_parse_error',
      `Failed to parse company policy seed YAML: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return normalizeCompanyPolicySeed(raw);
}

export function normalizeCompanyPolicySeed(raw: unknown): CompanyPolicySeed {
  const issues: string[] = [];
  const root = record(raw, 'seed', issues);

  const version = optionalSchemaVersion(root.version, issues);
  if (version !== COMPANY_POLICY_SCHEMA_VERSION) {
    issues.push(`version must be ${COMPANY_POLICY_SCHEMA_VERSION}`);
  }

  const users = arrayOfRecords(root.users, 'users', issues).map((entry, index) => normalizeUser(entry, `users[${index}]`, issues));
  const groups = arrayOfRecords(root.groups, 'groups', issues).map((entry, index) => normalizeGroup(entry, `groups[${index}]`, issues));
  const policies = arrayOfRecords(root.policies, 'policies', issues).map((entry, index) => normalizePolicy(entry, `policies[${index}]`, issues));
  const pathDefaults = arrayOfRecords(root.path_defaults, 'path_defaults', issues)
    .map((entry, index) => normalizePathDefault(entry, `path_defaults[${index}]`, issues));

  const userIds = assertUniqueIds(users.map((u) => u.id), 'users', issues);
  const groupIds = assertUniqueIds(groups.map((g) => g.id), 'groups', issues);
  const policyIds = assertUniqueIds(policies.map((p) => p.id), 'policies', issues);
  validateUniqueUserIdentityKeys(users, issues);

  for (const group of groups) {
    for (const userId of group.members) {
      if (!userIds.has(userId)) issues.push(`groups.${group.id}.members references unknown user "${userId}"`);
    }
  }

  for (const policy of policies) {
    validatePrincipalSet(policy.read, `policies.${policy.id}.read`, userIds, groupIds, issues);
    validatePrincipalSet(policy.write, `policies.${policy.id}.write`, userIds, groupIds, issues);
  }

  for (const pathDefault of pathDefaults) {
    if (!policyIds.has(pathDefault.visibility_policy_id)) {
      issues.push(`path_defaults.${pathDefault.path_prefix} references unknown policy "${pathDefault.visibility_policy_id}"`);
    }
  }

  const egress = normalizeEgress(optionalRecord(root.egress, 'egress', issues), issues);
  const audit = normalizeAudit(optionalRecord(root.audit, 'audit', issues), userIds, groupIds, issues);

  if (!policyIds.has(COMPANY_DEFAULT_POLICY_ID)) {
    issues.push(`policies must include Stage 1 default policy "${COMPANY_DEFAULT_POLICY_ID}"`);
  }

  if (issues.length > 0) {
    throw new CompanyPolicySeedError('invalid_seed', `Invalid company policy seed: ${issues.join('; ')}`, issues);
  }

  return {
    version: COMPANY_POLICY_SCHEMA_VERSION,
    users,
    groups,
    policies,
    path_defaults: pathDefaults,
    egress,
    audit,
  };
}

export function buildCompanyPolicyStorage(seed: CompanyPolicySeed): CompanyPolicyStorage {
  const grants: CompanyPolicyGrant[] = [];
  for (const policy of seed.policies) {
    for (const permission of ['read', 'write'] as const) {
      const principals = policy[permission];
      for (const userId of principals.users) {
        grants.push({ principal_type: 'user', principal_id: userId, policy_id: policy.id, permission });
      }
      for (const groupId of principals.groups) {
        grants.push({ principal_type: 'group', principal_id: groupId, policy_id: policy.id, permission });
      }
    }
  }

  return {
    schema_version: COMPANY_POLICY_SCHEMA_VERSION,
    kind: COMPANY_POLICY_STORAGE_KIND,
    enforcement: COMPANY_POLICY_ENFORCEMENT_STAGE,
    default_decision: COMPANY_POLICY_DEFAULT_DECISION,
    default_policy_id: COMPANY_DEFAULT_POLICY_ID,
    users: Object.fromEntries(seed.users.map((user) => [user.id, user])),
    groups: Object.fromEntries(seed.groups.map((group) => [group.id, group])),
    group_memberships: seed.groups.flatMap((group) => group.members.map((userId) => ({
      group_id: group.id,
      user_id: userId,
    }))),
    policies: Object.fromEntries(seed.policies.map((policy) => [policy.id, {
      id: policy.id,
      label: policy.label,
      description: policy.description,
    }])),
    grants,
    path_defaults: seed.path_defaults,
    egress: seed.egress,
    audit: seed.audit,
  };
}

export function buildCompanyPolicyMetadata(seed: CompanyPolicySeed): CompanyPolicyMetadata {
  const policyHash = stableSha256(seed);
  return {
    schema_version: COMPANY_POLICY_SCHEMA_VERSION,
    kind: COMPANY_POLICY_STORAGE_KIND,
    policy_version: `stage-2a-v${seed.version}-${policyHash.slice(0, 12)}`,
    policy_hash: policyHash,
    enforcement: COMPANY_POLICY_ENFORCEMENT_STAGE,
    default_decision: COMPANY_POLICY_DEFAULT_DECISION,
    default_policy_id: COMPANY_DEFAULT_POLICY_ID,
  };
}

export async function applyCompanyPolicySeed(
  engine: BrainEngine,
  seed: CompanyPolicySeed = buildDefaultCompanyPolicySeed(),
  primarySourceId = COMPANY_PRIMARY_SOURCE_ID,
): Promise<CompanyPolicyApplyResult> {
  const normalized = normalizeCompanyPolicySeed(seed);
  const storage = buildCompanyPolicyStorage(normalized);
  const metadata = buildCompanyPolicyMetadata(normalized);
  const policyConfig = { seed: normalized, storage, metadata };

  await engine.setConfig('company.policy', JSON.stringify(policyConfig));
  await engine.setConfig('company.policy.seed', JSON.stringify(normalized));
  await engine.setConfig('company.policy.storage', JSON.stringify(storage));
  await engine.setConfig('company.policy.metadata', JSON.stringify(metadata));
  await engine.setConfig('company.policy.version', metadata.policy_version);
  await engine.setConfig('company.policy.hash', metadata.policy_hash);
  await engine.setConfig('company.policy.default_policy_id', metadata.default_policy_id);
  await engine.setConfig('company.policy.default_decision', metadata.default_decision);
  await engine.setConfig('company.policy.enforcement', metadata.enforcement);

  await engine.executeRaw(
    `UPDATE sources
        SET config = config || $1::jsonb
      WHERE id = $2`,
    [JSON.stringify({
      company_policy_seed_version: metadata.policy_version,
      company_policy_hash: metadata.policy_hash,
      company_policy_enforcement: metadata.enforcement,
      company_policy_default_decision: metadata.default_decision,
      company_policy_default_policy_id: metadata.default_policy_id,
    }), primarySourceId],
  );

  return { seed: normalized, storage, metadata };
}

function normalizeUser(raw: Record<string, unknown>, path: string, issues: string[]): CompanyPolicySeedUser {
  const id = requiredId(raw.id, `${path}.id`, issues);
  return {
    id,
    email: optionalNullableString(raw.email, `${path}.email`, issues),
    idp_subjects: stringList(raw.idp_subjects, `${path}.idp_subjects`, issues),
    display_name: optionalNullableString(raw.display_name, `${path}.display_name`, issues),
    active: optionalBoolean(raw.active, true, `${path}.active`, issues),
  };
}

function normalizeGroup(raw: Record<string, unknown>, path: string, issues: string[]): CompanyPolicySeedGroup {
  if (raw.groups !== undefined) {
    issues.push(`${path}.groups nested groups are deferred to Stage 2B and are not accepted in Stage 2A`);
  }
  return {
    id: requiredId(raw.id, `${path}.id`, issues),
    label: optionalNullableString(raw.label, `${path}.label`, issues),
    members: stringList(raw.members, `${path}.members`, issues).map((member) => validateId(member, `${path}.members`, issues)),
  };
}

function normalizePolicy(raw: Record<string, unknown>, path: string, issues: string[]): CompanyPolicySeedPolicy {
  return {
    id: requiredId(raw.id, `${path}.id`, issues),
    label: optionalNullableString(raw.label, `${path}.label`, issues),
    description: optionalNullableString(raw.description, `${path}.description`, issues),
    read: normalizePrincipalSet(raw.read, `${path}.read`, issues),
    write: normalizePrincipalSet(raw.write, `${path}.write`, issues),
  };
}

function normalizePathDefault(raw: Record<string, unknown>, path: string, issues: string[]): CompanyPolicyPathDefault {
  const objectType = optionalString(raw.object_type, `${path}.object_type`, issues);
  if (objectType && !(COMPANY_OBJECT_TYPES as readonly string[]).includes(objectType)) {
    issues.push(`${path}.object_type must be one of ${COMPANY_OBJECT_TYPES.join(', ')}`);
  }
  const pathPrefix = requiredString(raw.path_prefix, `${path}.path_prefix`, issues);
  if (!pathPrefix.endsWith('/')) issues.push(`${path}.path_prefix must end with "/"`);
  return {
    ...(objectType ? { object_type: objectType as CompanyObjectType } : {}),
    path_prefix: pathPrefix,
    visibility_policy_id: requiredId(raw.visibility_policy_id, `${path}.visibility_policy_id`, issues),
  };
}

function normalizePrincipalSet(raw: unknown, path: string, issues: string[]): CompanyPolicyPrincipalSet {
  const value = optionalRecord(raw, path, issues);
  return {
    users: stringList(value.users, `${path}.users`, issues).map((id) => validateId(id, `${path}.users`, issues)),
    groups: stringList(value.groups, `${path}.groups`, issues).map((id) => validateId(id, `${path}.groups`, issues)),
  };
}

function normalizeEgress(raw: Record<string, unknown>, issues: string[]): CompanyPolicySeed['egress'] {
  const externalModel = optionalString(raw.external_model, 'egress.external_model', issues) ?? 'disabled_by_default';
  const externalWeb = optionalString(raw.external_web, 'egress.external_web', issues) ?? 'disabled_by_default';
  if (!EGRESS_VALUES.has(externalModel as CompanyPolicyEgressDecision)) {
    issues.push('egress.external_model must be disabled_by_default or allowed_by_policy');
  }
  if (!EGRESS_VALUES.has(externalWeb as CompanyPolicyEgressDecision)) {
    issues.push('egress.external_web must be disabled_by_default or allowed_by_policy');
  }
  return {
    external_model: externalModel as CompanyPolicyEgressDecision,
    external_web: externalWeb as CompanyPolicyEgressDecision,
  };
}

function normalizeAudit(
  raw: Record<string, unknown>,
  userIds: Set<string>,
  groupIds: Set<string>,
  issues: string[],
): CompanyPolicySeed['audit'] {
  const readers = normalizePrincipalSet(raw.readers, 'audit.readers', issues);
  validatePrincipalSet(readers, 'audit.readers', userIds, groupIds, issues);
  return { readers };
}

function validatePrincipalSet(
  principals: CompanyPolicyPrincipalSet,
  path: string,
  userIds: Set<string>,
  groupIds: Set<string>,
  issues: string[],
): void {
  for (const userId of principals.users) {
    if (!userIds.has(userId)) issues.push(`${path}.users references unknown user "${userId}"`);
  }
  for (const groupId of principals.groups) {
    if (!groupIds.has(groupId)) issues.push(`${path}.groups references unknown group "${groupId}"`);
  }
}

function validateUniqueUserIdentityKeys(users: CompanyPolicySeedUser[], issues: string[]): void {
  const emails = new Map<string, string>();
  const subjects = new Map<string, string>();

  for (const user of users) {
    const email = user.email?.trim().toLowerCase();
    if (email) {
      const previous = emails.get(email);
      if (previous) {
        issues.push(`users.${user.id}.email duplicates users.${previous}.email "${email}"`);
      } else {
        emails.set(email, user.id);
      }
    }

    for (const subject of user.idp_subjects) {
      const previous = subjects.get(subject);
      if (previous) {
        issues.push(`users.${user.id}.idp_subjects duplicates users.${previous}.idp_subjects "${subject}"`);
      } else {
        subjects.set(subject, user.id);
      }
    }
  }
}

function record(raw: unknown, path: string, issues: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push(`${path} must be a mapping`);
    return {};
  }
  return raw as Record<string, unknown>;
}

function optionalRecord(raw: unknown, path: string, issues: string[]): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  return record(raw, path, issues);
}

function arrayOfRecords(raw: unknown, path: string, issues: string[]): Record<string, unknown>[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issues.push(`${path} must be an array`);
    return [];
  }
  return raw.map((entry, index) => record(entry, `${path}[${index}]`, issues));
}

function assertUniqueIds(ids: string[], path: string, issues: string[]): Set<string> {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) issues.push(`${path} contains duplicate id "${id}"`);
    seen.add(id);
  }
  return seen;
}

function requiredId(raw: unknown, path: string, issues: string[]): string {
  return validateId(requiredString(raw, path, issues), path, issues);
}

function validateId(value: string, path: string, issues: string[]): string {
  if (!ID_RE.test(value)) {
    issues.push(`${path} must match ${ID_RE}`);
  }
  return value;
}

function requiredString(raw: unknown, path: string, issues: string[]): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    issues.push(`${path} must be a non-empty string`);
    return '';
  }
  return raw.trim();
}

function optionalString(raw: unknown, path: string, issues: string[]): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    issues.push(`${path} must be a string when set`);
    return null;
  }
  return raw.trim() || null;
}

function optionalNullableString(raw: unknown, path: string, issues: string[]): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'string') {
    issues.push(`${path} must be a string or null when set`);
    return undefined;
  }
  return raw.trim() || null;
}

function optionalBoolean(raw: unknown, fallback: boolean, path: string, issues: string[]): boolean {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'boolean') {
    issues.push(`${path} must be boolean when set`);
    return fallback;
  }
  return raw;
}

function optionalSchemaVersion(raw: unknown, issues: string[]): number {
  if (raw === undefined || raw === null) return COMPANY_POLICY_SCHEMA_VERSION;
  if (typeof raw !== 'number') {
    issues.push(`version must be ${COMPANY_POLICY_SCHEMA_VERSION}`);
    return COMPANY_POLICY_SCHEMA_VERSION;
  }
  return raw;
}

function stringList(raw: unknown, path: string, issues: string[]): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    issues.push(`${path} must be an array of strings`);
    return [];
  }
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const value = raw[i];
    if (typeof value !== 'string' || value.trim().length === 0) {
      issues.push(`${path}[${i}] must be a non-empty string`);
      continue;
    }
    out.push(value.trim());
  }
  return out;
}

function pathPrefixForObjectType(objectType: CompanyObjectType): string {
  switch (objectType) {
    case 'meeting': return 'meetings';
    case 'doc': return 'docs';
    case 'decision': return 'decisions';
    case 'commitment': return 'commitments';
    case 'evidence': return 'evidence';
    case 'person': return 'people';
    case 'project': return 'projects';
    case 'action': return 'actions';
  }
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
