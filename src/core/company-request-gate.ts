import type { OperationContext } from './operations.ts';
import { OperationError } from './operations.ts';
import {
  COMPANY_MODE_KIND,
  COMPANY_TRUST_MODE,
} from './company-mode.ts';

export const COMPANY_REQUEST_GATE_DENIAL =
  'Company policy context is required for hosted company requests.';

export type CompanyRequestGateReason =
  | 'not_hosted_company_request'
  | 'allowed'
  | 'missing_policy_context'
  | 'unresolved_identity'
  | 'ambiguous_identity'
  | 'policy_context_unavailable'
  | 'source_not_allowed'
  | 'source_missing';

export interface CompanyRequestGateResult {
  gated: boolean;
  allowed: boolean;
  reason: CompanyRequestGateReason;
}

export async function enforceHostedCompanyRequestGate(
  ctx: OperationContext,
  params: Record<string, unknown>,
): Promise<CompanyRequestGateResult> {
  const result = await evaluateHostedCompanyRequestGate(ctx, params);
  if (!result.allowed) {
    throw new OperationError('permission_denied', COMPANY_REQUEST_GATE_DENIAL);
  }
  return result;
}

export async function evaluateHostedCompanyRequestGate(
  ctx: OperationContext,
  params: Record<string, unknown> = {},
): Promise<CompanyRequestGateResult> {
  if (!await isHostedCompanyRequest(ctx)) {
    return { gated: false, allowed: true, reason: 'not_hosted_company_request' };
  }

  const companyContext = ctx.companyRequestContext;
  if (!companyContext) {
    return deny('missing_policy_context');
  }
  if (companyContext.identityStatus === 'ambiguous') {
    return deny('ambiguous_identity');
  }
  if (companyContext.identityStatus !== 'resolved' || !companyContext.userId) {
    return deny('unresolved_identity');
  }
  if (!companyContext.policyContextAvailable || companyContext.policyContextError) {
    return deny('policy_context_unavailable');
  }
  if (!companyContext.policyHash || !companyContext.policyVersion) {
    return deny('policy_context_unavailable');
  }

  const allowedSources = new Set(companyContext.allowedSources.length > 0
    ? companyContext.allowedSources
    : [companyContext.sourceId]);
  if (!allowedSources.has(companyContext.sourceId)) {
    return deny('source_not_allowed');
  }

  const requestedSources = extractRequestedSourceScope(params);
  if (requestedSources.allSources) {
    return deny('source_not_allowed');
  }
  for (const sourceId of requestedSources.sourceIds) {
    if (!allowedSources.has(sourceId)) {
      return deny('source_not_allowed');
    }
  }

  const sourcesToCheck = new Set([...allowedSources, companyContext.sourceId, ...requestedSources.sourceIds]);
  for (const sourceId of sourcesToCheck) {
    if (!await sourceExists(ctx, sourceId)) {
      return deny('source_missing');
    }
  }

  return { gated: true, allowed: true, reason: 'allowed' };
}

async function isHostedCompanyRequest(ctx: OperationContext): Promise<boolean> {
  if (ctx.remote !== true) return false;
  const [brainMode, companyMode, trustedWorkspace] = await Promise.all([
    getConfigSafe(ctx, 'brain.mode'),
    getConfigSafe(ctx, 'company.mode'),
    getConfigSafe(ctx, 'company.trusted_workspace'),
  ]);
  return brainMode === COMPANY_MODE_KIND
    || companyMode === COMPANY_TRUST_MODE
    || trustedWorkspace === 'true';
}

function extractRequestedSourceScope(params: Record<string, unknown>): { allSources: boolean; sourceIds: string[] } {
  const sourceIds = new Set<string>();
  let allSources = params.all_sources === true;
  const singleSource = stringParam(params.source_id) ?? stringParam(params.sourceId);
  if (singleSource === '__all__') {
    allSources = true;
  } else if (singleSource) {
    sourceIds.add(singleSource);
  }

  for (const key of ['source_ids', 'sourceIds', 'allowed_sources', 'allowedSources'] as const) {
    const values = params[key];
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      const sourceId = stringParam(value);
      if (!sourceId) continue;
      if (sourceId === '__all__') {
        allSources = true;
      } else {
        sourceIds.add(sourceId);
      }
    }
  }

  return { allSources, sourceIds: [...sourceIds].sort() };
}

async function sourceExists(ctx: OperationContext, sourceId: string): Promise<boolean> {
  try {
    const rows = await ctx.engine.executeRaw<{ id: string }>(
      `SELECT id FROM sources WHERE id = $1 AND archived = false`,
      [sourceId],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function getConfigSafe(ctx: OperationContext, key: string): Promise<string | null> {
  try {
    return await ctx.engine.getConfig(key);
  } catch {
    return null;
  }
}

function stringParam(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function deny(reason: Exclude<CompanyRequestGateReason, 'allowed' | 'not_hosted_company_request'>): CompanyRequestGateResult {
  return { gated: true, allowed: false, reason };
}
