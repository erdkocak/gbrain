import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from './engine.ts';
import { isValidSourceId } from './source-id.ts';

export const COMPANY_AUDIT_SCHEMA_VERSION = 1;
export const COMPANY_AUDIT_CHAIN_ID = 'hosted_company';

export const COMPANY_AUDIT_EVENT_TYPES = [
  'company.hosted.tool_list',
  'company.hosted.tool_call',
  'company.hosted.policy_decision',
  'company.hosted.read_result',
  'company.hosted.write_result',
  'company.hosted.derived_write',
  'company.hosted.denial',
] as const;

export type CompanyAuditEventType = typeof COMPANY_AUDIT_EVENT_TYPES[number];

export const COMPANY_AUDIT_STATUSES = [
  'attempted',
  'succeeded',
  'denied',
  'failed',
] as const;

export type CompanyAuditStatus = typeof COMPANY_AUDIT_STATUSES[number];

export const COMPANY_AUDIT_REQUIRED_FIELDS = [
  'event_id',
  'event_type',
  'timestamp',
  'request_id',
  'session_id',
  'user_id',
  'client_id',
  'client_name',
  'transport',
  'operation',
  'source_scope',
  'policy_decision_id',
  'policy_version',
  'policy_hash',
  'readable_policy_ids_hash',
  'writable_policy_ids_hash',
  'args_hash',
  'content_or_query_hash',
  'result_count',
  'object_ids_or_slugs',
  'status',
  'denial_reason',
  'previous_event_hash',
  'event_hash',
] as const;

export type CompanyAuditRequiredField = typeof COMPANY_AUDIT_REQUIRED_FIELDS[number];
export type CompanyAuditObjectRef = string | number;
export const COMPANY_AUDIT_HASH_RE = /^[0-9a-f]{64}$/;

export interface CompanyAuditSourceScope {
  source_id: string | null;
  requested_source_id: string | null;
  allowed_source_ids: string[];
  used_source_override: boolean;
  used_allowed_sources_override: boolean;
  federated_read: boolean;
}

export type CompanyAuditSourceScopeInput = Partial<CompanyAuditSourceScope>;

export class CompanyAuditError extends Error {
  constructor(
    public code:
      | 'invalid_audit_event'
      | 'unsupported_event_type'
      | 'unsupported_status'
      | 'append_only_violation',
    message: string,
  ) {
    super(message);
    this.name = 'CompanyAuditError';
  }
}

export interface CompanyAuditEventInput {
  event_id?: string;
  event_type: CompanyAuditEventType;
  timestamp?: string | Date;
  request_id: string;
  session_id?: string | null;
  user_id?: string | null;
  client_id?: string | null;
  client_name?: string | null;
  transport: string;
  operation?: string | null;
  source_scope?: CompanyAuditSourceScopeInput | null;
  policy_decision_id?: string | null;
  policy_version?: string | null;
  policy_hash?: string | null;
  readable_policy_ids?: readonly string[] | null;
  readable_policy_ids_hash?: string | null;
  writable_policy_ids?: readonly string[] | null;
  writable_policy_ids_hash?: string | null;
  args?: unknown;
  args_hash?: string | null;
  content_or_query?: unknown;
  content_or_query_hash?: string | null;
  result_count?: number | null;
  object_ids_or_slugs?: readonly CompanyAuditObjectRef[] | null;
  status: CompanyAuditStatus;
  denial_reason?: string | null;
}

export interface CompanyAuditEventRecord {
  schema_version: typeof COMPANY_AUDIT_SCHEMA_VERSION;
  event_id: string;
  event_type: CompanyAuditEventType;
  timestamp: string;
  request_id: string;
  session_id: string | null;
  user_id: string | null;
  client_id: string | null;
  client_name: string | null;
  transport: string;
  operation: string | null;
  source_scope: CompanyAuditSourceScope;
  policy_decision_id: string | null;
  policy_version: string | null;
  policy_hash: string | null;
  readable_policy_ids_hash: string | null;
  writable_policy_ids_hash: string | null;
  args_hash: string | null;
  content_or_query_hash: string | null;
  result_count: number | null;
  object_ids_or_slugs: CompanyAuditObjectRef[];
  status: CompanyAuditStatus;
  denial_reason: string | null;
  previous_event_hash: string | null;
  event_hash: string;
}

export type CompanyAuditMutation =
  | { kind: 'append'; event: CompanyAuditEventInput; chain_id?: string }
  | { kind: 'update'; event_id: string; changes: Record<string, unknown> }
  | { kind: 'delete'; event_id: string };

export function canonicalCompanyAuditJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalCompanyAuditJson(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalCompanyAuditJson(v)}`).join(',')}}`;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CompanyAuditError('invalid_audit_event', 'Company audit hashes require finite numbers.');
    }
  }
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new CompanyAuditError('invalid_audit_event', `Company audit hashes do not support ${typeof value} values.`);
  }
  return JSON.stringify(value);
}

export function hashCompanyAuditValue(value: unknown): string {
  return createHash('sha256').update(canonicalCompanyAuditJson(value), 'utf8').digest('hex');
}

export function hashCompanyAuditPolicyIds(policyIds: readonly string[] | null | undefined): string | null {
  if (!policyIds) return null;
  const normalized = Array.from(new Set(policyIds.map((id) => id.trim()).filter(Boolean))).sort();
  return hashCompanyAuditValue(normalized);
}

export function buildCompanyAuditEventRecord(
  input: CompanyAuditEventInput,
  previousEventHash: string | null,
): CompanyAuditEventRecord {
  validateEventType(input.event_type);
  validateStatus(input.status);

  const resultCount = input.result_count ?? null;
  if (resultCount !== null && (!Number.isInteger(resultCount) || resultCount < 0)) {
    throw new CompanyAuditError('invalid_audit_event', 'Company audit result_count must be a non-negative integer.');
  }

  const recordWithoutHash = {
    schema_version: COMPANY_AUDIT_SCHEMA_VERSION,
    event_id: normalizeOptionalText(input.event_id) ?? randomUUID(),
    event_type: input.event_type,
    timestamp: normalizeTimestamp(input.timestamp),
    request_id: normalizeRequiredText(input.request_id, 'request_id'),
    session_id: normalizeOptionalText(input.session_id),
    user_id: normalizeOptionalText(input.user_id),
    client_id: normalizeOptionalText(input.client_id),
    client_name: normalizeOptionalText(input.client_name),
    transport: normalizeRequiredText(input.transport, 'transport'),
    operation: normalizeOptionalText(input.operation),
    source_scope: normalizeSourceScope(input.source_scope),
    policy_decision_id: normalizeOptionalText(input.policy_decision_id),
    policy_version: normalizeOptionalText(input.policy_version),
    policy_hash: normalizeOptionalHash(input.policy_hash, 'policy_hash'),
    readable_policy_ids_hash: resolvePolicyIdsHash(
      input.readable_policy_ids_hash,
      input.readable_policy_ids,
      'readable_policy_ids_hash',
    ),
    writable_policy_ids_hash: resolvePolicyIdsHash(
      input.writable_policy_ids_hash,
      input.writable_policy_ids,
      'writable_policy_ids_hash',
    ),
    args_hash: resolveValueHash(input.args_hash, input.args, Object.prototype.hasOwnProperty.call(input, 'args'), 'args_hash'),
    content_or_query_hash: resolveValueHash(
      input.content_or_query_hash,
      input.content_or_query,
      Object.prototype.hasOwnProperty.call(input, 'content_or_query'),
      'content_or_query_hash',
    ),
    result_count: resultCount,
    object_ids_or_slugs: normalizeObjectRefs(input.object_ids_or_slugs),
    status: input.status,
    denial_reason: normalizeOptionalText(input.denial_reason),
    previous_event_hash: normalizeOptionalText(previousEventHash),
  } satisfies Omit<CompanyAuditEventRecord, 'event_hash'>;

  return {
    ...recordWithoutHash,
    event_hash: hashCompanyAuditValue(recordWithoutHash),
  };
}

export async function appendCompanyAuditEvent(
  engine: BrainEngine,
  input: CompanyAuditEventInput,
  opts: { chain_id?: string } = {},
): Promise<CompanyAuditEventRecord> {
  const chainId = normalizeOptionalText(opts.chain_id) ?? COMPANY_AUDIT_CHAIN_ID;
  return engine.transaction((tx) => appendCompanyAuditEventInTransaction(tx, input, { chain_id: chainId }));
}

export async function appendCompanyAuditEventInTransaction(
  engine: BrainEngine,
  input: CompanyAuditEventInput,
  opts: { chain_id?: string } = {},
): Promise<CompanyAuditEventRecord> {
  const chainId = normalizeOptionalText(opts.chain_id) ?? COMPANY_AUDIT_CHAIN_ID;
  await ensureCompanyAuditChainState(engine, chainId);
  const stateRows = await engine.executeRaw<{ last_event_hash: string | null }>(
    `SELECT last_event_hash FROM company_audit_chain_state WHERE chain_id = $1 FOR UPDATE`,
    [chainId],
  );
  const previousEventHash = stateRows[0]?.last_event_hash ?? null;
  const record = buildCompanyAuditEventRecord(input, previousEventHash);

  await engine.executeRaw(
    `INSERT INTO company_audit_events (
         event_id, schema_version, event_type, event_timestamp, request_id, session_id,
         user_id, client_id, client_name, transport, operation, source_scope,
         policy_decision_id, policy_version, policy_hash, readable_policy_ids_hash,
         writable_policy_ids_hash, args_hash, content_or_query_hash, result_count,
         object_ids_or_slugs, status, denial_reason, previous_event_hash, event_hash
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11, $12::jsonb,
         $13, $14, $15, $16,
         $17, $18, $19, $20,
         $21::jsonb, $22, $23, $24, $25
       )`,
    [
      record.event_id,
      record.schema_version,
      record.event_type,
      record.timestamp,
      record.request_id,
      record.session_id,
      record.user_id,
      record.client_id,
      record.client_name,
      record.transport,
      record.operation,
      JSON.stringify(record.source_scope),
      record.policy_decision_id,
      record.policy_version,
      record.policy_hash,
      record.readable_policy_ids_hash,
      record.writable_policy_ids_hash,
      record.args_hash,
      record.content_or_query_hash,
      record.result_count,
      JSON.stringify(record.object_ids_or_slugs),
      record.status,
      record.denial_reason,
      record.previous_event_hash,
      record.event_hash,
    ],
  );

  await engine.executeRaw(
    `UPDATE company_audit_chain_state
          SET last_event_hash = $2, updated_at = now()
        WHERE chain_id = $1`,
    [chainId, record.event_hash],
  );

  return record;
}

export async function applyCompanyAuditMutation(
  engine: BrainEngine,
  mutation: CompanyAuditMutation,
): Promise<CompanyAuditEventRecord> {
  if (mutation.kind === 'append') {
    return appendCompanyAuditEvent(engine, mutation.event, { chain_id: mutation.chain_id });
  }
  throw new CompanyAuditError(
    'append_only_violation',
    'Company audit events are append-only through application code.',
  );
}

async function ensureCompanyAuditChainState(engine: BrainEngine, chainId: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO company_audit_chain_state (chain_id, last_event_hash)
       VALUES ($1, NULL)
       ON CONFLICT (chain_id) DO NOTHING`,
    [chainId],
  );
}

function validateEventType(eventType: string): asserts eventType is CompanyAuditEventType {
  if (!(COMPANY_AUDIT_EVENT_TYPES as readonly string[]).includes(eventType)) {
    throw new CompanyAuditError('unsupported_event_type', `Unsupported company audit event type: ${eventType}`);
  }
}

function validateStatus(status: string): asserts status is CompanyAuditStatus {
  if (!(COMPANY_AUDIT_STATUSES as readonly string[]).includes(status)) {
    throw new CompanyAuditError('unsupported_status', `Unsupported company audit status: ${status}`);
  }
}

function normalizeTimestamp(value: string | Date | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new CompanyAuditError('invalid_audit_event', 'Company audit timestamp must be a valid date.');
    }
    return date.toISOString();
  }
  return new Date().toISOString();
}

function normalizeRequiredText(value: string | null | undefined, field: string): string {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    throw new CompanyAuditError('invalid_audit_event', `Company audit ${field} is required.`);
  }
  return normalized;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeOptionalHash(value: string | null | undefined, field: string): string | null {
  const normalized = normalizeOptionalText(value);
  if (normalized === null) return null;
  if (!COMPANY_AUDIT_HASH_RE.test(normalized)) {
    throw new CompanyAuditError(
      'invalid_audit_event',
      `Company audit ${field} must be a lowercase SHA-256 hex hash.`,
    );
  }
  return normalized;
}

function resolveValueHash(
  directHash: string | null | undefined,
  rawValue: unknown,
  hasRawValue: boolean,
  field: string,
): string | null {
  const normalized = normalizeOptionalHash(directHash, field);
  if (normalized !== null && hasRawValue) {
    throw new CompanyAuditError(
      'invalid_audit_event',
      `Company audit ${field} cannot be provided together with its raw value.`,
    );
  }
  if (normalized !== null) return normalized;
  return hasRawValue ? hashCompanyAuditValue(rawValue) : null;
}

function resolvePolicyIdsHash(
  directHash: string | null | undefined,
  policyIds: readonly string[] | null | undefined,
  field: string,
): string | null {
  const normalized = normalizeOptionalHash(directHash, field);
  if (normalized !== null && policyIds) {
    throw new CompanyAuditError(
      'invalid_audit_event',
      `Company audit ${field} cannot be provided together with policy ids.`,
    );
  }
  if (normalized !== null) return normalized;
  return hashCompanyAuditPolicyIds(policyIds);
}

function normalizeSourceScope(scope: CompanyAuditSourceScopeInput | null | undefined): CompanyAuditSourceScope {
  if (scope === null || scope === undefined) return emptySourceScope();
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new CompanyAuditError('invalid_audit_event', 'Company audit source_scope must be a routing metadata object.');
  }

  const allowedKeys = new Set([
    'source_id',
    'requested_source_id',
    'allowed_source_ids',
    'used_source_override',
    'used_allowed_sources_override',
    'federated_read',
  ]);
  for (const key of Object.keys(scope)) {
    if (!allowedKeys.has(key)) {
      throw new CompanyAuditError('invalid_audit_event', `Company audit source_scope contains unsupported field: ${key}`);
    }
  }

  return {
    source_id: normalizeSourceScopeId(scope.source_id, 'source_scope.source_id'),
    requested_source_id: normalizeRequestedSourceId(scope.requested_source_id),
    allowed_source_ids: normalizeSourceIdList(scope.allowed_source_ids, 'source_scope.allowed_source_ids'),
    used_source_override: normalizeSourceScopeBoolean(scope.used_source_override, 'source_scope.used_source_override'),
    used_allowed_sources_override: normalizeSourceScopeBoolean(
      scope.used_allowed_sources_override,
      'source_scope.used_allowed_sources_override',
    ),
    federated_read: normalizeSourceScopeBoolean(scope.federated_read, 'source_scope.federated_read'),
  };
}

function emptySourceScope(): CompanyAuditSourceScope {
  return {
    source_id: null,
    requested_source_id: null,
    allowed_source_ids: [],
    used_source_override: false,
    used_allowed_sources_override: false,
    federated_read: false,
  };
}

function normalizeRequestedSourceId(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalText(value);
  if (normalized === null) return null;
  if (normalized === '__all__') return normalized;
  return normalizeSourceScopeId(normalized, 'source_scope.requested_source_id');
}

function normalizeSourceScopeId(value: string | null | undefined, field: string): string | null {
  const normalized = normalizeOptionalText(value);
  if (normalized === null) return null;
  if (!isValidSourceId(normalized)) {
    throw new CompanyAuditError(
      'invalid_audit_event',
      `Company audit ${field} must be a valid source id.`,
    );
  }
  return normalized;
}

function normalizeSourceIdList(value: readonly string[] | null | undefined, field: string): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new CompanyAuditError('invalid_audit_event', `Company audit ${field} must be an array of source ids.`);
  }
  const ids = value.map((entry) => normalizeSourceScopeId(entry, field));
  return Array.from(new Set(ids.filter((entry): entry is string => entry !== null))).sort();
}

function normalizeSourceScopeBoolean(value: boolean | null | undefined, field: string): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value !== 'boolean') {
    throw new CompanyAuditError('invalid_audit_event', `Company audit ${field} must be a boolean.`);
  }
  return value;
}

function normalizeObjectRefs(values: readonly CompanyAuditObjectRef[] | null | undefined): CompanyAuditObjectRef[] {
  if (!values) return [];
  return values.map((value) => {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    throw new CompanyAuditError(
      'invalid_audit_event',
      'Company audit object_ids_or_slugs entries must be strings or finite numbers.',
    );
  });
}
