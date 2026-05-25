/**
 * Shared MCP tool-call dispatch — single source of truth for stdio + HTTP transports.
 *
 * Both transports validate the same params, build the same OperationContext shape,
 * and serialize errors identically. Drift between transports caused PR #483's reversed-args
 * + missing-context bugs; this module exists to prevent that recurring.
 */

import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';
import { operations, OperationError } from '../core/operations.ts';
import type { Operation, OperationContext, AuthInfo } from '../core/operations.ts';
import { loadConfig } from '../core/config.ts';
import { buildCompanyRequestContextFromOperationContext } from '../core/company-request-context.ts';
import type { CompanyIdentityInput, CompanyRequestContext } from '../core/company-request-context.ts';
import {
  COMPANY_REQUEST_GATE_DENIAL,
  evaluateHostedCompanyRequestGate,
  type CompanyRequestGateResult,
} from '../core/company-request-gate.ts';
import { hostedCompanyMutatingOperationDenial } from '../core/company-write-auth.ts';
import {
  filterHostedCompanyOperations,
  hostedCompanyToolAccessDenial,
} from '../core/company-hosted-tool-gate.ts';
import {
  appendCompanyAuditEvent,
  type CompanyAuditEventInput,
  type CompanyAuditEventType,
  type CompanyAuditStatus,
} from '../core/company-audit.ts';
import { isValidSourceId } from '../core/source-id.ts';

type CompanyAuditAppender = typeof appendCompanyAuditEvent;

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  /**
   * v0.31 (eD3): MCP spec-blessed metadata slot for server-supplied data.
   * The dispatcher injects `_meta.brain_hot_memory` here when an op succeeds
   * and the configured `metaHook` returns a payload.
   *
   * Existing clients ignore unknown `_meta` fields; capable clients (Claude
   * Code, Claude Desktop) read it. NOT a wrapper around the result body —
   * `content` stays the same shape it always had. Best-effort: any error in
   * the meta hook is absorbed and the tool call still succeeds.
   */
  _meta?: Record<string, unknown>;
}

export interface DispatchOpts {
  /** Defaults to true (remote/untrusted). Local CLI callers (`gbrain call`) pass false. */
  remote?: boolean;
  /** Override the default stderr logger (e.g. CLI uses console.* directly). */
  logger?: OperationContext['logger'];
  /**
   * v0.28: per-token allow-list for the takes.holder field. Threaded by
   * the HTTP/stdio transport from `access_tokens.permissions.takes_holders`.
   * When set, takes_list / takes_search / query (when it returns takes)
   * MUST filter `WHERE holder = ANY($takesHoldersAllowList)`. Local CLI
   * callers leave this unset (no filter — they own the brain).
   */
  takesHoldersAllowList?: string[];
  /**
   * v0.31 (eD4): tenancy axis for facts hot memory ops (extract_facts,
   * recall, forget_fact). When set, the OperationContext receives a
   * matching `sourceId`. CLI dispatch resolves this from --source flag /
   * GBRAIN_SOURCE / .gbrain-source / 'default'; HTTP MCP transport
   * resolves it from the per-token allow-list (eE3).
   */
  sourceId?: string;
  /**
   * v0.31 (eD3): hook called by the dispatcher AFTER op.handler succeeds
   * to compute `_meta.brain_hot_memory` for the response. Wrapped in its
   * own try/catch (eE4) so a DB blip in the helper degrades to no _meta
   * rather than flipping the whole tool call to error.
   *
   * Returning undefined means "no _meta to inject"; the dispatcher
   * preserves the existing response shape.
   */
  metaHook?: (
    name: string,
    ctx: OperationContext,
  ) => Promise<Record<string, unknown> | undefined>;
  /**
   * OAuth auth info threaded through from the HTTP MCP transport. Set so
   * the whoami op (and any future scope-aware op handlers) can introspect
   * the calling identity. Without this, every whoami call from HTTP
   * transports throws unknown_transport — the v0.31 D12 / eE1 refactor
   * silently dropped this field when the inlined OperationContext literal
   * was replaced by dispatchToolCall.
   */
  auth?: AuthInfo;
  /**
   * Company-brain request context. If omitted, dispatch attempts a best-effort
   * context build from company.policy.* config before invoking the handler.
   * This is representational only; operations are not policy-enforced here.
   */
  companyRequestContext?: CompanyRequestContext;
  companyIdentity?: CompanyIdentityInput;
  requestId?: string;
  sessionId?: string | null;
  /**
   * Optional audit appender override for failure-injection tests. Production
   * dispatch uses the durable hash-chained audit appender.
   */
  companyAuditAppend?: CompanyAuditAppender;
}

/**
 * Build a privacy-safe summary of MCP request params for logging + the admin
 * SSE feed.
 *
 * The previous default of `JSON.stringify(params)` wrote raw payloads —
 * page bodies, search queries, file paths — into `mcp_request_log` and
 * broadcast them to every connected admin browser. For a personal-knowledge
 * brain those payloads include private notes about real people / deals /
 * companies, retained indefinitely.
 *
 * The redactor returns the SHAPE of the request (what op was called, which
 * declared params were passed, approximate size) without any of the values.
 *
 * Hardening note (codex C8): a naive "dump all submitted keys" summary still
 * leaks via attacker-controlled key names — a caller can submit
 * `put_page {"wiki/people/sensitive_name": "..."}` and the key becomes a
 * persistent log entry. To prevent this, we intersect submitted keys
 * against the operation's declared `params` allow-list (the same definition
 * `validateParams` reads). Anything outside the allow-list is counted but
 * not named.
 *
 * Operators who want full payloads for debugging set `--log-full-params` on
 * `gbrain serve --http`; that path bypasses this helper and writes the raw
 * JSON, with a loud startup warning.
 */
export interface ParamSummary {
  redacted: true;
  kind: 'array' | 'object' | string;
  declared_keys?: string[];
  unknown_key_count?: number;
  length?: number;
  approx_bytes?: number;
}

/**
 * Round a byte count UP to the nearest 1KB so the redacted summary keeps a
 * coarse size signal without enabling a size-based side channel.
 *
 * Why bucketing matters: the previous shape published `approx_bytes` as the
 * exact JSON.stringify(params).length. An attacker who can submit
 * `put_page` with a known prefix and observe the resulting log entry
 * could binary-search the byte length of secret content (the body the
 * legitimate user just wrote) via repeated probes. Bucketing to 1KB
 * resolution destroys that channel while preserving the operator-useful
 * "roughly how large was the request" signal.
 */
function bucketBytes(n: number | undefined): number | undefined {
  if (n === undefined || !Number.isFinite(n)) return undefined;
  if (n <= 0) return 0;
  const KB = 1024;
  return Math.ceil(n / KB) * KB;
}

export function summarizeMcpParams(opName: string, params: unknown): ParamSummary | null {
  if (params == null) return null;

  let approxBytes: number | undefined;
  try { approxBytes = bucketBytes(JSON.stringify(params).length); } catch { approxBytes = undefined; }

  if (Array.isArray(params)) {
    return {
      redacted: true,
      kind: 'array',
      length: params.length,
      ...(approxBytes !== undefined ? { approx_bytes: approxBytes } : {}),
    };
  }

  if (typeof params === 'object') {
    const submittedKeys = Object.keys(params as Record<string, unknown>);
    const op = operations.find(o => o.name === opName);
    const allowList = op ? new Set(Object.keys(op.params)) : new Set<string>();
    const declared: string[] = [];
    let unknown = 0;
    for (const k of submittedKeys) {
      if (allowList.has(k)) declared.push(k);
      else unknown += 1;
    }
    declared.sort();
    return {
      redacted: true,
      kind: 'object',
      declared_keys: declared,
      unknown_key_count: unknown,
      ...(approxBytes !== undefined ? { approx_bytes: approxBytes } : {}),
    };
  }

  return {
    redacted: true,
    kind: typeof params,
    ...(approxBytes !== undefined ? { approx_bytes: approxBytes } : {}),
  };
}

/** Validate required params exist and have the expected type. Returns null on success, error message on failure. */
export function validateParams(op: Operation, params: Record<string, unknown>): string | null {
  for (const [key, def] of Object.entries(op.params)) {
    if (def.required && (params[key] === undefined || params[key] === null)) {
      return `Missing required parameter: ${key}`;
    }
    if (params[key] !== undefined && params[key] !== null) {
      const val = params[key];
      const expected = def.type;
      if (expected === 'string' && typeof val !== 'string') return `Parameter "${key}" must be a string`;
      if (expected === 'number' && typeof val !== 'number') return `Parameter "${key}" must be a number`;
      if (expected === 'boolean' && typeof val !== 'boolean') return `Parameter "${key}" must be a boolean`;
      if (expected === 'object' && (typeof val !== 'object' || Array.isArray(val))) return `Parameter "${key}" must be an object`;
      if (expected === 'array' && !Array.isArray(val)) return `Parameter "${key}" must be an array`;
    }
  }
  return null;
}

const stderrLogger: OperationContext['logger'] = {
  info: (msg: string) => process.stderr.write(`[info] ${msg}\n`),
  warn: (msg: string) => process.stderr.write(`[warn] ${msg}\n`),
  error: (msg: string) => process.stderr.write(`[error] ${msg}\n`),
};

const COMPANY_AUDIT_APPEND_FAILURE_MESSAGE =
  'Company audit append failed for hosted company request.';

function errorToolResult(error: OperationError): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(error.toJSON(), null, 2) }], isError: true };
}

function invalidParamsToolResult(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_params', message }, null, 2) }],
    isError: true,
  };
}

function unknownToolResult(name: string): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_tool', message: `Unknown tool: ${name}` }, null, 2) }],
    isError: true,
  };
}

function internalErrorToolResult(e: unknown): ToolResult {
  const msg = e instanceof Error ? e.message : String(e);
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: 'internal_error', message: msg }, null, 2) }],
    isError: true,
  };
}

interface DispatchAuditEvent {
  event_type: CompanyAuditEventType;
  operation: string;
  status: CompanyAuditStatus;
  args?: unknown;
  result_count?: number | null;
  object_ids_or_slugs?: readonly (string | number)[];
  denial_reason?: string | null;
}

async function appendHostedCompanyAuditEvent(
  ctx: OperationContext,
  opts: DispatchOpts,
  params: Record<string, unknown>,
  requestId: string,
  event: DispatchAuditEvent,
): Promise<boolean> {
  const companyContext = ctx.companyRequestContext;
  const input: CompanyAuditEventInput = {
    event_type: event.event_type,
    request_id: requestId,
    session_id: normalizeTransportAuditId(opts.sessionId),
    user_id: companyContext?.userId ?? ctx.auth?.companyUserId ?? opts.companyIdentity?.userId ?? null,
    client_id: companyContext?.clientId ?? ctx.auth?.clientId ?? opts.companyIdentity?.clientId ?? null,
    client_name: companyContext?.clientName ?? ctx.auth?.clientName ?? opts.companyIdentity?.clientName ?? null,
    transport: companyContext?.transport ?? inferAuditTransport(ctx),
    operation: event.operation,
    source_scope: auditSourceScope(ctx, params),
    policy_decision_id: companyContext?.policyDecisionId ?? null,
    policy_version: companyContext?.policyVersion ?? null,
    policy_hash: companyContext?.policyHash ?? null,
    readable_policy_ids: companyContext?.readablePolicyIds ?? null,
    writable_policy_ids: companyContext?.writablePolicyIds ?? null,
    result_count: event.result_count ?? null,
    object_ids_or_slugs: event.object_ids_or_slugs ?? [],
    status: event.status,
    denial_reason: event.denial_reason ?? null,
  };
  if (Object.prototype.hasOwnProperty.call(event, 'args')) {
    input.args = event.args;
  }

  try {
    const append = opts.companyAuditAppend ?? appendCompanyAuditEvent;
    await append(ctx.engine, input);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.logger.error(`[mcp] hosted company audit append failed for ${event.operation}: ${msg}`);
    return false;
  }
}

async function appendHostedCompanyAuditOrFailClosed(
  ctx: OperationContext,
  opts: DispatchOpts,
  params: Record<string, unknown>,
  requestId: string,
  event: DispatchAuditEvent,
): Promise<ToolResult | null> {
  const appended = await appendHostedCompanyAuditEvent(ctx, opts, params, requestId, event);
  if (appended || isBestEffortAuditOperation(event.operation)) return null;
  return errorToolResult(new OperationError('permission_denied', COMPANY_AUDIT_APPEND_FAILURE_MESSAGE));
}

function resolveHostedCompanyAuditRequestId(ctx: OperationContext, opts: DispatchOpts): string {
  return ctx.companyRequestContext?.requestId ?? opts.requestId ?? randomUUID();
}

function isBestEffortAuditOperation(operation: string): boolean {
  return operation === 'whoami';
}

function requestGateAuditReason(result: CompanyRequestGateResult): string | null {
  if (result.allowed || result.reason === 'allowed' || result.reason === 'not_hosted_company_request') return null;
  return `request_gate_${result.reason}`;
}

function operationFailureAuditReason(e: unknown): string {
  if (e instanceof OperationError) return `operation_error_${safeAuditReasonCode(e.code)}`;
  return 'internal_error';
}

function safeAuditReasonCode(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_:-]/g, '_');
  return normalized.length > 0 ? normalized : 'unknown';
}

function inferAuditTransport(ctx: OperationContext): string {
  if (ctx.remote === false) return 'local_cli';
  if (!ctx.auth) return 'stdio_mcp';
  return ctx.auth.clientId.startsWith('gbrain_cl_') ? 'hosted_mcp_oauth' : 'hosted_mcp_legacy_token';
}

function auditSourceScope(ctx: OperationContext, params: Record<string, unknown>): NonNullable<CompanyAuditEventInput['source_scope']> {
  const companyContext = ctx.companyRequestContext;
  const sourceId = auditSourceId(companyContext?.sourceId ?? ctx.sourceId ?? ctx.auth?.sourceId ?? null);
  const allowedSourceIds = uniqueSortedStrings(
    (companyContext?.allowedSources?.length ? companyContext.allowedSources : ctx.auth?.allowedSources ?? [])
      .map((entry) => auditSourceId(entry))
      .filter((entry): entry is string => entry !== null),
  );
  const normalizedAllowedSourceIds = allowedSourceIds.length > 0
    ? allowedSourceIds
    : sourceId
      ? [sourceId]
      : [];

  return {
    source_id: sourceId,
    requested_source_id: requestedAuditSourceId(params),
    allowed_source_ids: normalizedAllowedSourceIds,
    used_source_override: hasOwn(params, 'source_id') || hasOwn(params, 'sourceId') || params.all_sources === true,
    used_allowed_sources_override: hasOwn(params, 'allowed_sources')
      || hasOwn(params, 'allowedSources')
      || hasOwn(params, 'source_ids')
      || hasOwn(params, 'sourceIds'),
    federated_read: normalizedAllowedSourceIds.length > 1,
  };
}

function requestedAuditSourceId(params: Record<string, unknown>): string | null {
  if (params.all_sources === true) return '__all__';
  const direct = auditSourceId(stringAuditParam(params, 'source_id') ?? stringAuditParam(params, 'sourceId'), {
    allowAll: true,
  });
  if (direct) return direct;

  const requested = uniqueSortedStrings([
    ...auditSourceIdArrayParam(params, 'allowed_sources'),
    ...auditSourceIdArrayParam(params, 'allowedSources'),
    ...auditSourceIdArrayParam(params, 'source_ids'),
    ...auditSourceIdArrayParam(params, 'sourceIds'),
  ]);
  if (requested.includes('__all__')) return '__all__';
  return requested.length === 1 ? requested[0]! : null;
}

function auditSourceIdArrayParam(params: Record<string, unknown>, key: string): string[] {
  const value = params[key];
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => auditSourceId(entry, { allowAll: true }))
    .filter((entry): entry is string => entry !== null);
}

function auditSourceId(value: unknown, opts: { allowAll?: boolean } = {}): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (opts.allowAll && trimmed === '__all__') return trimmed;
  return isValidSourceId(trimmed) ? trimmed : null;
}

function stringAuditParam(params: Record<string, unknown>, key: string): string | null {
  const value = params[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeTransportAuditId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128) return null;
  return /^[A-Za-z0-9._:@/-]+$/.test(trimmed) ? trimmed : null;
}

function uniqueSortedStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function buildOperationContext(
  engine: BrainEngine,
  params: Record<string, unknown>,
  opts: DispatchOpts = {},
): OperationContext {
  return {
    engine,
    config: loadConfig() || { engine: 'postgres' },
    logger: opts.logger || stderrLogger,
    dryRun: !!params.dry_run,
    remote: opts.remote ?? true,
    takesHoldersAllowList: opts.takesHoldersAllowList,
    // v0.34 D4: sourceId is REQUIRED at the type level. Auto-fill 'default'
    // for single-source brains and any caller who didn't resolve a sourceId.
    // CLI / HTTP / stdio transports SHOULD pass an explicit sourceId via opts;
    // this fallback covers code paths that historically passed undefined.
    sourceId: opts.sourceId ?? 'default',
    auth: opts.auth,
  };
}

async function attachCompanyRequestContext(
  ctx: OperationContext,
  params: Record<string, unknown>,
  opts: DispatchOpts,
): Promise<void> {
  if (opts.companyRequestContext) {
    ctx.companyRequestContext = opts.companyRequestContext;
    return;
  }
  const companyRequestContext = await buildCompanyRequestContextFromOperationContext(ctx, params, {
    requestId: opts.requestId,
    sessionId: opts.sessionId,
    identity: opts.companyIdentity,
  });
  if (companyRequestContext) ctx.companyRequestContext = companyRequestContext;
}

export async function listVisibleOperationsForDispatch(
  engine: BrainEngine,
  opts: DispatchOpts = {},
): Promise<Operation[]> {
  const remote = opts.remote ?? true;
  const visible = remote
    ? operations.filter((op) => !op.localOnly)
    : operations;
  const ctx = buildOperationContext(engine, {}, opts);
  await attachCompanyRequestContext(ctx, {}, opts);
  const requestGate = await evaluateHostedCompanyRequestGate(ctx, {});
  if (!requestGate.gated) return visible;
  const auditRequestId = resolveHostedCompanyAuditRequestId(ctx, opts);
  if (!requestGate.allowed) {
    await appendHostedCompanyAuditEvent(ctx, opts, {}, auditRequestId, {
      event_type: 'company.hosted.denial',
      operation: 'tools/list',
      status: 'denied',
      denial_reason: requestGateAuditReason(requestGate),
    });
    return [];
  }
  const filtered = await filterHostedCompanyOperations(ctx, visible);
  const appended = await appendHostedCompanyAuditEvent(ctx, opts, {}, auditRequestId, {
    event_type: 'company.hosted.tool_list',
    operation: 'tools/list',
    status: 'succeeded',
    result_count: filtered.length,
    object_ids_or_slugs: filtered.map((op) => op.name).sort(),
  });
  return appended ? filtered : [];
}

/**
 * Resolve operation, validate params, build context, invoke handler, format result.
 *
 * Returns a `ToolResult` with the same shape both MCP transports need:
 * `{ content: [{ type: 'text', text }], isError?: boolean }`.
 */
export async function dispatchToolCall(
  engine: BrainEngine,
  name: string,
  params: Record<string, unknown> | undefined,
  opts: DispatchOpts = {},
): Promise<ToolResult> {
  const safeParams = params || {};
  const op = operations.find(o => o.name === name);
  if (!op) {
    // Always return JSON-shaped error content. v0.31 e2e tests
    // (sources-remote-mcp.test.ts) parse content via JSON.parse so a
    // plain `Error: ...` string here breaks the contract on every
    // unknown-op path and the resulting test failure looked like a
    // transport bug.
    const ctx = buildOperationContext(engine, safeParams, opts);
    await attachCompanyRequestContext(ctx, safeParams, opts);
    const requestGate = await evaluateHostedCompanyRequestGate(ctx, safeParams);
    if (!requestGate.gated) return unknownToolResult(name);

    const auditRequestId = resolveHostedCompanyAuditRequestId(ctx, opts);
    const auditFailure = await appendHostedCompanyAuditOrFailClosed(ctx, opts, safeParams, auditRequestId, {
      event_type: 'company.hosted.denial',
      operation: 'unknown_tool',
      status: 'denied',
      args: safeParams,
      denial_reason: requestGate.allowed ? 'unknown_tool' : requestGateAuditReason(requestGate),
    });
    if (auditFailure) return auditFailure;
    if (!requestGate.allowed) {
      return errorToolResult(new OperationError('permission_denied', COMPANY_REQUEST_GATE_DENIAL));
    }
    return unknownToolResult(name);
  }

  const ctx = buildOperationContext(engine, safeParams, opts);
  await attachCompanyRequestContext(ctx, safeParams, opts);
  const requestGate = await evaluateHostedCompanyRequestGate(ctx, safeParams);
  const auditRequired = requestGate.gated;
  const auditRequestId = auditRequired ? resolveHostedCompanyAuditRequestId(ctx, opts) : '';

  if (auditRequired && !requestGate.allowed) {
    const auditFailure = await appendHostedCompanyAuditOrFailClosed(ctx, opts, safeParams, auditRequestId, {
      event_type: 'company.hosted.denial',
      operation: name,
      status: 'denied',
      args: safeParams,
      denial_reason: requestGateAuditReason(requestGate),
    });
    if (auditFailure) return auditFailure;
    return errorToolResult(new OperationError('permission_denied', COMPANY_REQUEST_GATE_DENIAL));
  }

  if (auditRequired && op.localOnly && (opts.remote ?? true) !== false) {
    const err = new OperationError(
      'permission_denied',
      `${name} is local-only and cannot be invoked by remote MCP callers.`,
    );
    const auditFailure = await appendHostedCompanyAuditOrFailClosed(ctx, opts, safeParams, auditRequestId, {
      event_type: 'company.hosted.denial',
      operation: name,
      status: 'denied',
      args: safeParams,
      denial_reason: 'local_only_tool',
    });
    if (auditFailure) return auditFailure;
    return errorToolResult(err);
  }

  const writeDenial = auditRequired
    ? hostedCompanyMutatingOperationDenial(ctx, { name, mutating: op.mutating })
    : null;
  if (writeDenial) {
    const auditFailure = await appendHostedCompanyAuditOrFailClosed(ctx, opts, safeParams, auditRequestId, {
      event_type: 'company.hosted.denial',
      operation: name,
      status: 'denied',
      args: safeParams,
      denial_reason: 'hosted_write_gate_denied',
    });
    if (auditFailure) return auditFailure;
    return errorToolResult(new OperationError('permission_denied', writeDenial));
  }

  const toolDenial = auditRequired ? await hostedCompanyToolAccessDenial(ctx, op) : null;
  if (toolDenial) {
    const auditFailure = await appendHostedCompanyAuditOrFailClosed(ctx, opts, safeParams, auditRequestId, {
      event_type: 'company.hosted.denial',
      operation: name,
      status: 'denied',
      args: safeParams,
      denial_reason: 'hosted_tool_gate_denied',
    });
    if (auditFailure) return auditFailure;
    return errorToolResult(new OperationError('permission_denied', toolDenial));
  }

  const validationError = validateParams(op, safeParams);
  if (validationError) {
    if (auditRequired) {
      const auditFailure = await appendHostedCompanyAuditOrFailClosed(ctx, opts, safeParams, auditRequestId, {
        event_type: 'company.hosted.tool_call',
        operation: name,
        status: 'failed',
        args: safeParams,
        denial_reason: 'invalid_params',
      });
      if (auditFailure) return auditFailure;
    }
    return invalidParamsToolResult(validationError);
  }
  if (op.localOnly && (opts.remote ?? true) !== false) {
    const err = new OperationError(
      'permission_denied',
      `${name} is local-only and cannot be invoked by remote MCP callers.`,
    );
    if (auditRequired) {
      const auditFailure = await appendHostedCompanyAuditOrFailClosed(ctx, opts, safeParams, auditRequestId, {
        event_type: 'company.hosted.denial',
        operation: name,
        status: 'denied',
        args: safeParams,
        denial_reason: 'local_only_tool',
      });
      if (auditFailure) return auditFailure;
    }
    return errorToolResult(err);
  }

  try {
    if (auditRequired) {
      const auditFailure = await appendHostedCompanyAuditOrFailClosed(ctx, opts, safeParams, auditRequestId, {
        event_type: 'company.hosted.tool_call',
        operation: name,
        status: 'attempted',
        args: safeParams,
      });
      if (auditFailure) return auditFailure;
    }
    const result = await op.handler(ctx, safeParams);
    const out: ToolResult = { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    // v0.31 (eD3 + eE4): best-effort _meta.brain_hot_memory injection.
    // The hook is wrapped in its own try/catch — any DB blip / cache miss /
    // helper crash degrades to no `_meta` rather than flipping the whole
    // tool call to error.
    if (opts.metaHook) {
      try {
        const meta = await opts.metaHook(name, ctx);
        if (meta && Object.keys(meta).length > 0) out._meta = meta;
      } catch (metaErr) {
        const msg = metaErr instanceof Error ? metaErr.message : String(metaErr);
        ctx.logger.warn(`[mcp] _meta hook failed for ${name}: ${msg}; degrading to no-_meta`);
      }
    }
    if (auditRequired && !op.mutating) {
      const auditFailure = await appendHostedCompanyAuditOrFailClosed(ctx, opts, safeParams, auditRequestId, {
        event_type: 'company.hosted.tool_call',
        operation: name,
        status: 'succeeded',
        args: safeParams,
      });
      if (auditFailure) return auditFailure;
    }
    return out;
  } catch (e: unknown) {
    if (auditRequired && !op.mutating) {
      const auditFailure = await appendHostedCompanyAuditOrFailClosed(ctx, opts, safeParams, auditRequestId, {
        event_type: 'company.hosted.tool_call',
        operation: name,
        status: 'failed',
        args: safeParams,
        denial_reason: operationFailureAuditReason(e),
      });
      if (auditFailure) return auditFailure;
    }
    if (e instanceof OperationError) {
      return errorToolResult(e);
    }
    // Non-OperationError (uncaught throws) — wrap in the same shape so
    // every error response is JSON-parseable. The pre-v0.31 path emitted
    // plain `Error: ${msg}` strings here, which broke any caller that
    // tried JSON.parse(content).
    return internalErrorToolResult(e);
  }
}
