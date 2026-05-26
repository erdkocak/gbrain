import type { BrainEngine } from './engine.ts';
import {
  buildCompanyAuditEventRecord,
  COMPANY_AUDIT_CHAIN_ID,
  type CompanyAuditEventRecord,
  type CompanyAuditEventType,
  type CompanyAuditObjectRef,
  type CompanyAuditSourceScope,
  type CompanyAuditStatus,
} from './company-audit.ts';
import type { CompanyPolicyPrincipalSet, CompanyPolicyStorage } from './company-policy.ts';
import { loadCompanyPolicyConfigSnapshot, type CompanyRequestContext } from './company-request-context.ts';
import { pageVisibilityPolicyIds } from './company-read-filter.ts';
import { isValidSourceId } from './source-id.ts';

export class CompanyAuditReadError extends Error {
  constructor(
    public code: 'invalid_input' | 'policy_unavailable' | 'permission_denied',
    message: string,
  ) {
    super(message);
    this.name = 'CompanyAuditReadError';
  }
}

export interface CompanyAuditReadInput {
  requestContext?: CompanyRequestContext;
  trustedLocalAdmin?: boolean;
  limit?: number;
  eventTypes?: readonly CompanyAuditEventType[];
  operations?: readonly string[];
}

export interface CompanyAuditRedactedEvent {
  sequence_id: number;
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
  denial_reason_redacted: boolean;
  previous_event_hash: string | null;
  event_hash: string;
}

export interface CompanyAuditReadResult {
  kind: 'company_audit_read';
  allowed: true;
  access: {
    mode: 'trusted_local_admin' | 'audit_reader';
    user_id: string | null;
    policy_version: string | null;
    filtered_by_object_policy: boolean;
    denial_reasons_redacted: boolean;
  };
  events: CompanyAuditRedactedEvent[];
  redaction: {
    raw_args_excluded: true;
    raw_content_or_query_excluded: true;
    hidden_object_rows_filtered: boolean;
  };
}

export type CompanyAuditVerificationIssueCode =
  | 'event_hash_mismatch'
  | 'previous_hash_mismatch'
  | 'chain_state_missing'
  | 'chain_state_mismatch'
  | 'invalid_row';

export interface CompanyAuditVerificationIssue {
  code: CompanyAuditVerificationIssueCode;
  sequence_id: number | null;
  event_id: string | null;
  message: string;
}

export interface CompanyAuditVerificationResult {
  kind: 'company_audit_verification';
  chain_id: string;
  valid: boolean;
  event_count: number;
  last_event_hash: string | null;
  chain_state_last_event_hash: string | null;
  issues: CompanyAuditVerificationIssue[];
}

interface CompanyAuditDbRow {
  sequence_id: number | string | bigint;
  event_id: string;
  schema_version: number | string;
  event_type: CompanyAuditEventType;
  event_timestamp: string | Date;
  request_id: string;
  session_id: string | null;
  user_id: string | null;
  client_id: string | null;
  client_name: string | null;
  transport: string;
  operation: string | null;
  source_scope: unknown;
  policy_decision_id: string | null;
  policy_version: string | null;
  policy_hash: string | null;
  readable_policy_ids_hash: string | null;
  writable_policy_ids_hash: string | null;
  args_hash: string | null;
  content_or_query_hash: string | null;
  result_count: number | string | null;
  object_ids_or_slugs: unknown;
  status: CompanyAuditStatus;
  denial_reason: string | null;
  previous_event_hash: string | null;
  event_hash: string;
}

interface AuditReadScope {
  mode: 'trusted_local_admin' | 'audit_reader';
  userId: string | null;
  readablePolicyIds: Set<string>;
  allowedSourceIds: Set<string>;
  sourceId: string | null;
  policyVersion: string | null;
  redactDenialReasons: boolean;
}

interface PagePolicyRow {
  slug?: string | null;
  source_id?: string | null;
  frontmatter?: unknown;
}

interface SlugRef {
  key: string;
  slug: string;
  sourceIds: string[];
}

export async function readCompanyAuditLog(
  engine: BrainEngine,
  input: CompanyAuditReadInput = {},
): Promise<CompanyAuditReadResult> {
  const limit = normalizeLimit(input.limit);
  const snapshot = input.trustedLocalAdmin === true
    ? await loadCompanyPolicyConfigSnapshot(engine).catch(() => null)
    : await requireCompanyPolicySnapshot(engine);
  const scope = authorizeAuditRead(input.requestContext, snapshot?.storage ?? null, input.trustedLocalAdmin === true);
  const scanLimit = scope.mode === 'trusted_local_admin' ? limit : Math.max(limit * 5, 100);
  const rows = await fetchAuditRows(engine, { ...input, limit: scanLimit });
  const events: CompanyAuditRedactedEvent[] = [];
  let hiddenObjectRowsFiltered = false;

  for (const row of rows) {
    const visible = await auditRowVisible(engine, row, scope);
    if (!visible) {
      hiddenObjectRowsFiltered = true;
      continue;
    }
    events.push(redactAuditRow(row, scope));
    if (events.length >= limit) break;
  }

  return {
    kind: 'company_audit_read',
    allowed: true,
    access: {
      mode: scope.mode,
      user_id: scope.userId,
      policy_version: scope.policyVersion,
      filtered_by_object_policy: scope.mode === 'audit_reader',
      denial_reasons_redacted: scope.redactDenialReasons,
    },
    events,
    redaction: {
      raw_args_excluded: true,
      raw_content_or_query_excluded: true,
      hidden_object_rows_filtered: hiddenObjectRowsFiltered,
    },
  };
}

export async function verifyCompanyAuditHashChain(
  engine: BrainEngine,
  opts: { chainId?: string } = {},
): Promise<CompanyAuditVerificationResult> {
  const chainId = opts.chainId?.trim() || COMPANY_AUDIT_CHAIN_ID;
  const rows = await fetchAuditRows(engine, { ascending: true });
  const issues: CompanyAuditVerificationIssue[] = [];
  let previousStoredHash: string | null = null;

  for (const row of rows) {
    const sequenceId = numeric(row.sequence_id);
    try {
      const record = rebuildRecordFromRow(row);
      if (row.previous_event_hash !== previousStoredHash) {
        issues.push({
          code: 'previous_hash_mismatch',
          sequence_id: sequenceId,
          event_id: row.event_id,
          message: `Expected previous_event_hash ${previousStoredHash ?? 'null'} but found ${row.previous_event_hash ?? 'null'}.`,
        });
      }
      if (record.event_hash !== row.event_hash) {
        issues.push({
          code: 'event_hash_mismatch',
          sequence_id: sequenceId,
          event_id: row.event_id,
          message: 'Stored event_hash does not match the canonical row hash.',
        });
      }
    } catch (e) {
      issues.push({
        code: 'invalid_row',
        sequence_id: sequenceId,
        event_id: row.event_id ?? null,
        message: e instanceof Error ? e.message : String(e),
      });
    }
    previousStoredHash = row.event_hash;
  }

  const stateRows = await engine.executeRaw<{ last_event_hash: string | null }>(
    `SELECT last_event_hash FROM company_audit_chain_state WHERE chain_id = $1`,
    [chainId],
  );
  const chainStateLastHash = stateRows[0]?.last_event_hash ?? null;
  if (stateRows.length === 0) {
    issues.push({
      code: 'chain_state_missing',
      sequence_id: null,
      event_id: null,
      message: `Audit chain state row is missing for ${chainId}.`,
    });
  } else if (chainStateLastHash !== previousStoredHash) {
    issues.push({
      code: 'chain_state_mismatch',
      sequence_id: null,
      event_id: null,
      message: `Chain state last_event_hash ${chainStateLastHash ?? 'null'} does not match last stored event hash ${previousStoredHash ?? 'null'}.`,
    });
  }

  return {
    kind: 'company_audit_verification',
    chain_id: chainId,
    valid: issues.length === 0,
    event_count: rows.length,
    last_event_hash: previousStoredHash,
    chain_state_last_event_hash: chainStateLastHash,
    issues,
  };
}

async function requireCompanyPolicySnapshot(engine: BrainEngine) {
  const snapshot = await loadCompanyPolicyConfigSnapshot(engine);
  if (!snapshot) {
    throw new CompanyAuditReadError(
      'policy_unavailable',
      'Company policy storage is required to read company audit events.',
    );
  }
  return snapshot;
}

function authorizeAuditRead(
  requestContext: CompanyRequestContext | undefined,
  storage: CompanyPolicyStorage | null,
  trustedLocalAdmin: boolean,
): AuditReadScope {
  if (trustedLocalAdmin) {
    return {
      mode: 'trusted_local_admin',
      userId: requestContext?.userId ?? null,
      readablePolicyIds: new Set(requestContext?.readablePolicyIds ?? []),
      allowedSourceIds: new Set(requestContext?.allowedSources?.length ? requestContext.allowedSources : [requestContext?.sourceId ?? 'company']),
      sourceId: requestContext?.sourceId ?? null,
      policyVersion: requestContext?.policyVersion ?? null,
      redactDenialReasons: false,
    };
  }

  if (!storage || !requestContext || requestContext.identityStatus !== 'resolved' || !requestContext.policyContextAvailable) {
    throw new CompanyAuditReadError(
      'permission_denied',
      'Resolved company policy context is required to read company audit events.',
    );
  }
  if (!principalSetIncludesUser(storage.audit.readers, requestContext.userId, requestContext.groupIds)) {
    throw new CompanyAuditReadError(
      'permission_denied',
      'Company audit events are available only to configured audit readers.',
    );
  }

  return {
    mode: 'audit_reader',
    userId: requestContext.userId,
    readablePolicyIds: new Set(requestContext.readablePolicyIds),
    allowedSourceIds: new Set(requestContext.allowedSources.length > 0 ? requestContext.allowedSources : [requestContext.sourceId]),
    sourceId: requestContext.sourceId,
    policyVersion: requestContext.policyVersion,
    redactDenialReasons: true,
  };
}

function principalSetIncludesUser(
  principalSet: CompanyPolicyPrincipalSet,
  userId: string | null,
  groupIds: readonly string[],
): boolean {
  if (!userId) return false;
  if (principalSet.users.includes(userId)) return true;
  const groupSet = new Set(groupIds);
  return principalSet.groups.some((groupId) => groupSet.has(groupId));
}

async function fetchAuditRows(
  engine: BrainEngine,
  opts: CompanyAuditReadInput & { ascending?: boolean; limit?: number },
): Promise<CompanyAuditDbRow[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const eventTypes = uniqueSorted(opts.eventTypes ?? []);
  if (eventTypes.length > 0) {
    params.push(eventTypes);
    clauses.push(`event_type = ANY($${params.length}::text[])`);
  }
  const operations = uniqueSorted((opts.operations ?? []).map((op) => op.trim()).filter(Boolean));
  if (operations.length > 0) {
    params.push(operations);
    clauses.push(`operation = ANY($${params.length}::text[])`);
  }
  if (opts.limit !== undefined) params.push(opts.limit);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const order = opts.ascending ? 'ASC' : 'DESC';
  const limitSql = opts.limit === undefined ? '' : `LIMIT $${params.length}`;
  return engine.executeRaw<CompanyAuditDbRow>(
    `SELECT sequence_id, event_id, schema_version, event_type, event_timestamp,
            request_id, session_id, user_id, client_id, client_name, transport,
            operation, source_scope, policy_decision_id, policy_version, policy_hash,
            readable_policy_ids_hash, writable_policy_ids_hash, args_hash,
            content_or_query_hash, result_count, object_ids_or_slugs, status,
            denial_reason, previous_event_hash, event_hash
       FROM company_audit_events
       ${where}
      ORDER BY sequence_id ${order}
      ${limitSql}`,
    params,
  );
}

async function auditRowVisible(
  engine: BrainEngine,
  row: CompanyAuditDbRow,
  scope: AuditReadScope,
): Promise<boolean> {
  if (scope.mode === 'trusted_local_admin') return true;
  const refs = parseObjectRefs(row.object_ids_or_slugs);
  if (refs.length === 0) return true;
  if (row.event_type === 'company.hosted.tool_list') return true;
  return auditRefsReadable(engine, refs, parseSourceScope(row.source_scope), scope);
}

async function auditRefsReadable(
  engine: BrainEngine,
  refs: readonly CompanyAuditObjectRef[],
  rowSourceScope: CompanyAuditSourceScope,
  scope: AuditReadScope,
): Promise<boolean> {
  const slugRefs = expandSlugRefs(refs.filter((ref): ref is string => typeof ref === 'string'), rowSourceScope, scope);
  const numericRefs = refs.filter((ref): ref is number => typeof ref === 'number' && Number.isFinite(ref));
  if (numericRefs.length > 0) return false;
  if (slugRefs.length === 0) return refs.length === 0;

  const readableSlugRefs = await readableSlugRefKeys(engine, slugRefs, scope);
  for (const ref of slugRefs) {
    if (!readableSlugRefs.has(ref.key)) return false;
  }

  return true;
}

function expandSlugRefs(
  refs: readonly string[],
  rowSourceScope: CompanyAuditSourceScope,
  scope: AuditReadScope,
): SlugRef[] {
  const out: SlugRef[] = [];
  for (const ref of refs) {
    const prefixed = splitSourcePrefixedSlug(ref);
    if (prefixed) {
      out.push({ key: `${prefixed.sourceId}\0${prefixed.slug}`, sourceIds: [prefixed.sourceId], slug: prefixed.slug });
      continue;
    }
    const sourceIds = candidateSourceIds(rowSourceScope, scope);
    out.push({ key: `${sourceIds.join('|')}\0${ref}`, sourceIds, slug: ref });
  }
  return out;
}

function splitSourcePrefixedSlug(ref: string): { sourceId: string; slug: string } | null {
  const idx = ref.indexOf(':');
  if (idx <= 0) return null;
  const sourceId = ref.slice(0, idx);
  const slug = ref.slice(idx + 1);
  if (!slug || !isValidSourceId(sourceId)) return null;
  return { sourceId, slug };
}

function candidateSourceIds(rowSourceScope: CompanyAuditSourceScope, scope: AuditReadScope): string[] {
  const rowAllowed = rowSourceScope.allowed_source_ids.filter((sourceId) => scope.allowedSourceIds.has(sourceId));
  if (rowSourceScope.source_id && scope.allowedSourceIds.has(rowSourceScope.source_id)) return [rowSourceScope.source_id];
  if (rowAllowed.length > 0) return rowAllowed;
  if (scope.sourceId && scope.allowedSourceIds.has(scope.sourceId)) return [scope.sourceId];
  return [...scope.allowedSourceIds].sort();
}

async function readableSlugRefKeys(
  engine: BrainEngine,
  refs: readonly SlugRef[],
  scope: AuditReadScope,
): Promise<Set<string>> {
  const expanded = refs.flatMap((ref) => ref.sourceIds.map((sourceId) => ({ sourceId, slug: ref.slug })));
  if (expanded.length === 0) return new Set();
  const deduped = [...new Map(expanded.map((ref) => [`${ref.sourceId}\0${ref.slug}`, ref])).values()];
  const rows = await engine.executeRaw<PagePolicyRow>(
    `SELECT p.slug, p.source_id, p.frontmatter
       FROM pages p
       JOIN unnest($1::text[], $2::text[]) AS requested(slug, source_id)
         ON p.slug = requested.slug AND p.source_id = requested.source_id
      WHERE p.deleted_at IS NULL`,
    [deduped.map((ref) => ref.slug), deduped.map((ref) => ref.sourceId)],
  );
  const readableExact = new Set(
    rows
      .filter((row) => row.source_id && row.slug && pageRowReadable(row, scope))
      .map((row) => `${row.source_id}\0${row.slug}`),
  );
  const readableRequested = new Set<string>();
  for (const ref of refs) {
    if (ref.sourceIds.some((sourceId) => readableExact.has(`${sourceId}\0${ref.slug}`))) {
      readableRequested.add(ref.key);
    }
  }
  return readableRequested;
}

function pageRowReadable(row: PagePolicyRow, scope: AuditReadScope): boolean {
  const sourceId = typeof row.source_id === 'string' ? row.source_id : null;
  if (!sourceId || !scope.allowedSourceIds.has(sourceId)) return false;
  const policyIds = pageVisibilityPolicyIds(parseRecord(row.frontmatter));
  return policyIds.some((policyId) => scope.readablePolicyIds.has(policyId));
}

function redactAuditRow(row: CompanyAuditDbRow, scope: AuditReadScope): CompanyAuditRedactedEvent {
  const denialReasonRedacted = scope.redactDenialReasons && row.denial_reason !== null;
  return {
    sequence_id: numeric(row.sequence_id),
    event_id: row.event_id,
    event_type: row.event_type,
    timestamp: timestampIso(row.event_timestamp),
    request_id: row.request_id,
    session_id: row.session_id,
    user_id: row.user_id,
    client_id: row.client_id,
    client_name: row.client_name,
    transport: row.transport,
    operation: row.operation,
    source_scope: parseSourceScope(row.source_scope),
    policy_decision_id: row.policy_decision_id,
    policy_version: row.policy_version,
    policy_hash: row.policy_hash,
    readable_policy_ids_hash: row.readable_policy_ids_hash,
    writable_policy_ids_hash: row.writable_policy_ids_hash,
    args_hash: row.args_hash,
    content_or_query_hash: row.content_or_query_hash,
    result_count: nullableNumeric(row.result_count),
    object_ids_or_slugs: parseObjectRefs(row.object_ids_or_slugs),
    status: row.status,
    denial_reason: denialReasonRedacted ? null : row.denial_reason,
    denial_reason_redacted: denialReasonRedacted,
    previous_event_hash: row.previous_event_hash,
    event_hash: row.event_hash,
  };
}

function rebuildRecordFromRow(row: CompanyAuditDbRow): CompanyAuditEventRecord {
  return buildCompanyAuditEventRecord({
    event_id: row.event_id,
    event_type: row.event_type,
    timestamp: timestampIso(row.event_timestamp),
    request_id: row.request_id,
    session_id: row.session_id,
    user_id: row.user_id,
    client_id: row.client_id,
    client_name: row.client_name,
    transport: row.transport,
    operation: row.operation,
    source_scope: parseSourceScope(row.source_scope),
    policy_decision_id: row.policy_decision_id,
    policy_version: row.policy_version,
    policy_hash: row.policy_hash,
    readable_policy_ids_hash: row.readable_policy_ids_hash,
    writable_policy_ids_hash: row.writable_policy_ids_hash,
    args_hash: row.args_hash,
    content_or_query_hash: row.content_or_query_hash,
    result_count: nullableNumeric(row.result_count),
    object_ids_or_slugs: parseObjectRefs(row.object_ids_or_slugs),
    status: row.status,
    denial_reason: row.denial_reason,
  }, row.previous_event_hash);
}

function parseSourceScope(value: unknown): CompanyAuditSourceScope {
  const parsed = parseRecord(value);
  return {
    source_id: stringOrNull(parsed.source_id),
    requested_source_id: stringOrNull(parsed.requested_source_id),
    allowed_source_ids: Array.isArray(parsed.allowed_source_ids)
      ? uniqueSorted(parsed.allowed_source_ids.filter((entry): entry is string => typeof entry === 'string'))
      : [],
    used_source_override: parsed.used_source_override === true,
    used_allowed_sources_override: parsed.used_allowed_sources_override === true,
    federated_read: parsed.federated_read === true,
  };
}

function parseObjectRefs(value: unknown): CompanyAuditObjectRef[] {
  const parsed = parseJson(value, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is CompanyAuditObjectRef => (
    typeof entry === 'string' || (typeof entry === 'number' && Number.isFinite(entry))
  ));
}

function parseRecord(value: unknown): Record<string, unknown> {
  const parsed = parseJson(value, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function parseJson(value: unknown, fallback: unknown): unknown {
  if (typeof value !== 'string') return value ?? fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw new CompanyAuditReadError('invalid_input', 'Company audit read limit must be an integer from 1 to 200.');
  }
  return value;
}

function numeric(value: number | string | bigint): number {
  return typeof value === 'bigint' ? Number(value) : Number(value);
}

function nullableNumeric(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

function timestampIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}
