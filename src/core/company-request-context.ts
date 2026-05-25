import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from './engine.ts';
import type { AuthInfo, OperationContext } from './operations.ts';
import {
  type CompanyPolicyMetadata,
  type CompanyPolicyStorage,
} from './company-policy.ts';
import {
  COMPANY_POLICY_EVALUATOR_KIND,
  evaluateCompanyPolicyForUser,
  type CompanyPolicyUserEvaluation,
} from './company-policy-evaluator.ts';

export const COMPANY_REQUEST_CONTEXT_KIND = 'company_request_context';
export const COMPANY_REQUEST_CONTEXT_ENFORCEMENT = 'represented_not_enforced';

export type CompanyRequestTransport =
  | 'local_cli'
  | 'stdio_mcp'
  | 'hosted_mcp_oauth'
  | 'hosted_mcp_legacy_token'
  | 'subagent';

export type CompanyIdentityResolutionStatus =
  | 'trusted_local'
  | 'resolved'
  | 'ambiguous'
  | 'unresolved';

export type CompanyIdentityResolutionSource =
  | 'trusted_local'
  | 'explicit_user_id'
  | 'idp_subject'
  | 'email'
  | 'oauth_client_id'
  | 'oauth_client_name'
  | 'none';

export interface CompanyIdentityInput {
  userId?: string | null;
  email?: string | null;
  idpSubject?: string | null;
  clientId?: string | null;
  clientName?: string | null;
}

export interface CompanyIdentityResolution {
  status: CompanyIdentityResolutionStatus;
  source: CompanyIdentityResolutionSource;
  userId: string | null;
  email: string | null;
  idpSubject: string | null;
}

export interface CompanyRequestContext {
  schema_version: 1;
  kind: typeof COMPANY_REQUEST_CONTEXT_KIND;
  enforcement: typeof COMPANY_REQUEST_CONTEXT_ENFORCEMENT;
  evaluator_kind: typeof COMPANY_POLICY_EVALUATOR_KIND;
  requestId: string;
  brainId: string;
  sourceId: string;
  allowedSources: string[];
  remote: boolean;
  transport: CompanyRequestTransport;
  userId: string | null;
  userEmail: string | null;
  idpSubject: string | null;
  identityStatus: CompanyIdentityResolutionStatus;
  identitySource: CompanyIdentityResolutionSource;
  clientId: string | null;
  clientName: string | null;
  scopes: string[];
  groupIds: string[];
  readablePolicyIds: string[];
  writablePolicyIds: string[];
  policyVersion: string | null;
  policyHash: string | null;
  policyDecisionId: string;
  sessionId: string | null;
  jobContext: {
    jobId: number | null;
    subagentId: number | null;
    viaSubagent: boolean;
  } | null;
  trustedWorkspace: boolean;
  legacyTakesHoldersAllowList: string[] | null;
  policyContextAvailable: boolean;
  policyContextError?: string;
  sourceRouting: {
    sourceId: string;
    allowedSources: string[];
    independentOfPolicyGrants: true;
  };
}

export interface CompanyRequestContextInput {
  requestId?: string;
  brainId?: string;
  sourceId?: string;
  allowedSources?: string[];
  remote: boolean;
  auth?: AuthInfo & {
    companyUserId?: string;
    userEmail?: string;
    idpSubject?: string;
  };
  identity?: CompanyIdentityInput;
  storage?: CompanyPolicyStorage;
  metadata?: CompanyPolicyMetadata;
  trustedWorkspace?: boolean;
  sessionId?: string | null;
  jobId?: number;
  subagentId?: number;
  viaSubagent?: boolean;
  legacyTakesHoldersAllowList?: string[];
}

export interface CompanyPolicyConfigSnapshot {
  storage: CompanyPolicyStorage;
  metadata?: CompanyPolicyMetadata;
  trustedWorkspace: boolean;
}

export function resolveCompanyIdentity(
  storage: CompanyPolicyStorage,
  input: CompanyIdentityInput,
  opts: { trustedLocal?: boolean } = {},
): CompanyIdentityResolution {
  if (opts.trustedLocal && !input.userId && !input.email && !input.idpSubject && !input.clientId && !input.clientName) {
    return {
      status: 'trusted_local',
      source: 'trusted_local',
      userId: null,
      email: null,
      idpSubject: null,
    };
  }

  const userId = normalizeString(input.userId);
  if (userId && storage.users[userId]) {
    const user = storage.users[userId]!;
    return identity('resolved', 'explicit_user_id', user.id, user.email ?? null, null);
  }

  const idpSubject = normalizeString(input.idpSubject);
  if (idpSubject) {
    const match = findUniqueUser(storage, (candidate) => candidate.idp_subjects.includes(idpSubject));
    if (match === 'ambiguous') return identity('ambiguous', 'idp_subject', null, null, idpSubject);
    if (match) return identity('resolved', 'idp_subject', match.id, match.email ?? null, idpSubject);
  }

  const email = normalizeString(input.email)?.toLowerCase() ?? null;
  if (email) {
    const match = findUniqueUser(storage, (candidate) => candidate.email?.toLowerCase() === email);
    if (match === 'ambiguous') return identity('ambiguous', 'email', null, email, idpSubject);
    if (match) return identity('resolved', 'email', match.id, match.email ?? email, idpSubject);
  }

  for (const candidate of oauthClientSubjectCandidates(input.clientId, input.clientName)) {
    const match = findUniqueUser(storage, (entry) => entry.idp_subjects.includes(candidate.subject));
    if (match === 'ambiguous') return identity('ambiguous', candidate.source, null, email, candidate.subject);
    if (match) return identity('resolved', candidate.source, match.id, match.email ?? email, candidate.subject);
  }

  return {
    status: 'unresolved',
    source: 'none',
    userId: null,
    email,
    idpSubject,
  };
}

export function buildCompanyRequestContext(input: CompanyRequestContextInput): CompanyRequestContext {
  const brainId = normalizeString(input.brainId) ?? 'host';
  const sourceId = normalizeString(input.sourceId) ?? input.auth?.sourceId ?? 'default';
  const allowedSources = normalizeAllowedSources(input.allowedSources ?? input.auth?.allowedSources, sourceId);
  const transport = classifyCompanyRequestTransport(input.remote, input.auth, input.viaSubagent);
  const identityInput = normalizeIdentityInput(input);
  const requestId = normalizeString(input.requestId) ?? randomUUID();
  const trustedLocal = input.remote === false;

  if (!input.storage) {
    const unresolved = trustedLocal
      ? identity('trusted_local', 'trusted_local', null, identityInput.email ?? null, identityInput.idpSubject ?? null)
      : identity('unresolved', 'none', null, identityInput.email ?? null, identityInput.idpSubject ?? null);
    return finalizeCompanyRequestContext({
      input,
      requestId,
      brainId,
      sourceId,
      allowedSources,
      transport,
      resolvedIdentity: unresolved,
      evaluation: null,
      policyContextError: 'company policy storage unavailable',
    });
  }

  let resolvedIdentity: CompanyIdentityResolution;
  try {
    resolvedIdentity = resolveCompanyIdentity(input.storage, identityInput, { trustedLocal });
  } catch (e) {
    resolvedIdentity = trustedLocal
      ? identity('trusted_local', 'trusted_local', null, identityInput.email ?? null, identityInput.idpSubject ?? null)
      : identity('unresolved', 'none', null, identityInput.email ?? null, identityInput.idpSubject ?? null);
    return finalizeCompanyRequestContext({
      input,
      requestId,
      brainId,
      sourceId,
      allowedSources,
      transport,
      resolvedIdentity,
      evaluation: null,
      policyContextError: e instanceof Error ? e.message : String(e),
    });
  }
  try {
    const evaluation = evaluateCompanyPolicyForUser(input.storage, resolvedIdentity.userId, input.metadata);
    return finalizeCompanyRequestContext({
      input,
      requestId,
      brainId,
      sourceId,
      allowedSources,
      transport,
      resolvedIdentity,
      evaluation,
    });
  } catch (e) {
    return finalizeCompanyRequestContext({
      input,
      requestId,
      brainId,
      sourceId,
      allowedSources,
      transport,
      resolvedIdentity,
      evaluation: null,
      policyContextError: e instanceof Error ? e.message : String(e),
    });
  }
}

export async function loadCompanyPolicyConfigSnapshot(engine: BrainEngine): Promise<CompanyPolicyConfigSnapshot | null> {
  let storageRaw: string | null;
  try {
    storageRaw = await engine.getConfig('company.policy.storage');
  } catch {
    return null;
  }
  if (!storageRaw) return null;

  let storage: CompanyPolicyStorage;
  try {
    storage = JSON.parse(storageRaw) as CompanyPolicyStorage;
  } catch {
    return null;
  }

  let metadata: CompanyPolicyMetadata | undefined;
  try {
    const metadataRaw = await engine.getConfig('company.policy.metadata');
    if (metadataRaw) {
      metadata = JSON.parse(metadataRaw) as CompanyPolicyMetadata;
      const [policyHash, policyVersion] = await Promise.all([
        engine.getConfig('company.policy.hash').catch(() => null),
        engine.getConfig('company.policy.version').catch(() => null),
      ]);
      if (policyHash && metadata.policy_hash !== policyHash) return null;
      if (policyVersion && metadata.policy_version !== policyVersion) return null;
    }
  } catch {
    return null;
  }

  let trustedWorkspace = false;
  try {
    trustedWorkspace = (await engine.getConfig('company.trusted_workspace')) === 'true'
      || (await engine.getConfig('company.mode')) === 'trusted_workspace';
  } catch {
    trustedWorkspace = false;
  }

  return { storage, metadata, trustedWorkspace };
}

export async function buildCompanyRequestContextFromOperationContext(
  ctx: OperationContext,
  params: Record<string, unknown> = {},
  opts: { requestId?: string; sessionId?: string | null; identity?: CompanyIdentityInput } = {},
): Promise<CompanyRequestContext | undefined> {
  const snapshot = await loadCompanyPolicyConfigSnapshot(ctx.engine);
  if (!snapshot) return undefined;

  const localIdentity = ctx.remote === false
    ? {
      userId: stringParam(params, 'user_id') ?? stringParam(params, 'company_user_id'),
      email: stringParam(params, 'email') ?? stringParam(params, 'user_email'),
      idpSubject: stringParam(params, 'idp_subject'),
    }
    : {};
  const identity = {
    ...localIdentity,
    ...opts.identity,
  };

  return buildCompanyRequestContext({
    requestId: opts.requestId,
    brainId: ctx.brainId,
    sourceId: ctx.sourceId,
    allowedSources: ctx.auth?.allowedSources,
    remote: ctx.remote,
    auth: ctx.auth,
    identity,
    storage: snapshot.storage,
    metadata: snapshot.metadata,
    trustedWorkspace: snapshot.trustedWorkspace,
    sessionId: opts.sessionId ?? stringParam(params, 'session_id'),
    jobId: ctx.jobId,
    subagentId: ctx.subagentId,
    viaSubagent: ctx.viaSubagent,
    legacyTakesHoldersAllowList: ctx.takesHoldersAllowList,
  });
}

function finalizeCompanyRequestContext(args: {
  input: CompanyRequestContextInput;
  requestId: string;
  brainId: string;
  sourceId: string;
  allowedSources: string[];
  transport: CompanyRequestTransport;
  resolvedIdentity: CompanyIdentityResolution;
  evaluation: CompanyPolicyUserEvaluation | null;
  policyContextError?: string;
}): CompanyRequestContext {
  const { input, requestId, brainId, sourceId, allowedSources, transport, resolvedIdentity, evaluation } = args;
  const groupIds = evaluation?.group_ids ?? [];
  const readablePolicyIds = evaluation?.readable_policy_ids ?? [];
  const writablePolicyIds = evaluation?.writable_policy_ids ?? [];
  const policyHash = evaluation?.policy_hash ?? null;
  const policyVersion = evaluation?.policy_version ?? null;
  const policyDecisionId = stableDecisionId({
    requestId,
    userId: resolvedIdentity.userId,
    groupIds,
    readablePolicyIds,
    writablePolicyIds,
    policyHash,
    sourceId,
    allowedSources,
  });
  const jobContext = input.jobId !== undefined || input.subagentId !== undefined || input.viaSubagent !== undefined
    ? {
      jobId: input.jobId ?? null,
      subagentId: input.subagentId ?? null,
      viaSubagent: input.viaSubagent === true,
    }
    : null;

  return {
    schema_version: 1,
    kind: COMPANY_REQUEST_CONTEXT_KIND,
    enforcement: COMPANY_REQUEST_CONTEXT_ENFORCEMENT,
    evaluator_kind: COMPANY_POLICY_EVALUATOR_KIND,
    requestId,
    brainId,
    sourceId,
    allowedSources,
    remote: input.remote,
    transport,
    userId: resolvedIdentity.userId,
    userEmail: resolvedIdentity.email,
    idpSubject: resolvedIdentity.idpSubject,
    identityStatus: resolvedIdentity.status,
    identitySource: resolvedIdentity.source,
    clientId: input.auth?.clientId ?? normalizeString(input.identity?.clientId) ?? null,
    clientName: input.auth?.clientName ?? normalizeString(input.identity?.clientName) ?? null,
    scopes: uniqueSorted(input.auth?.scopes ?? []),
    groupIds,
    readablePolicyIds,
    writablePolicyIds,
    policyVersion,
    policyHash,
    policyDecisionId,
    sessionId: normalizeString(input.sessionId) ?? null,
    jobContext,
    trustedWorkspace: input.trustedWorkspace === true,
    legacyTakesHoldersAllowList: input.legacyTakesHoldersAllowList ? uniqueSorted(input.legacyTakesHoldersAllowList) : null,
    policyContextAvailable: evaluation !== null,
    ...(args.policyContextError ? { policyContextError: args.policyContextError } : {}),
    sourceRouting: {
      sourceId,
      allowedSources,
      independentOfPolicyGrants: true,
    },
  };
}

function normalizeIdentityInput(input: CompanyRequestContextInput): CompanyIdentityInput {
  return {
    userId: input.identity?.userId ?? input.auth?.companyUserId,
    email: input.identity?.email ?? input.auth?.userEmail,
    idpSubject: input.identity?.idpSubject ?? input.auth?.idpSubject,
    clientId: input.identity?.clientId ?? input.auth?.clientId,
    clientName: input.identity?.clientName ?? input.auth?.clientName,
  };
}

function classifyCompanyRequestTransport(
  remote: boolean,
  auth: CompanyRequestContextInput['auth'],
  viaSubagent?: boolean,
): CompanyRequestTransport {
  if (viaSubagent) return 'subagent';
  if (remote === false) return 'local_cli';
  if (!auth) return 'stdio_mcp';
  return auth.clientId.startsWith('gbrain_cl_') ? 'hosted_mcp_oauth' : 'hosted_mcp_legacy_token';
}

function identity(
  status: CompanyIdentityResolutionStatus,
  source: CompanyIdentityResolutionSource,
  userId: string | null,
  email: string | null,
  idpSubject: string | null,
): CompanyIdentityResolution {
  return { status, source, userId, email, idpSubject };
}

function oauthClientSubjectCandidates(
  clientId: string | null | undefined,
  clientName: string | null | undefined,
): Array<{ subject: string; source: Extract<CompanyIdentityResolutionSource, 'oauth_client_id' | 'oauth_client_name'> }> {
  const out: Array<{ subject: string; source: Extract<CompanyIdentityResolutionSource, 'oauth_client_id' | 'oauth_client_name'> }> = [];
  const normalizedClientId = normalizeString(clientId);
  if (normalizedClientId) {
    out.push({ subject: `oauth-client:${normalizedClientId}`, source: 'oauth_client_id' });
    out.push({ subject: `oauth_client:${normalizedClientId}`, source: 'oauth_client_id' });
    out.push({ subject: `client:${normalizedClientId}`, source: 'oauth_client_id' });
  }
  const normalizedClientName = normalizeString(clientName);
  if (normalizedClientName) {
    out.push({ subject: `oauth-client-name:${normalizedClientName}`, source: 'oauth_client_name' });
    out.push({ subject: `client-name:${normalizedClientName}`, source: 'oauth_client_name' });
  }
  return out;
}

function findUniqueUser(
  storage: CompanyPolicyStorage,
  predicate: (user: CompanyPolicyStorage['users'][string]) => boolean,
): CompanyPolicyStorage['users'][string] | 'ambiguous' | null {
  const matches = Object.values(storage.users).filter(predicate);
  if (matches.length === 0) return null;
  if (matches.length > 1) return 'ambiguous';
  return matches[0]!;
}

function normalizeAllowedSources(raw: string[] | undefined, sourceId: string): string[] {
  const allowed = uniqueSorted((raw ?? []).map((value) => value.trim()).filter(Boolean));
  return allowed.length > 0 ? allowed : [sourceId];
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function uniqueSorted(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function stableDecisionId(value: unknown): string {
  return `cpd_${stableSha256(value).slice(0, 16)}`;
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
