import type { OperationContext } from './operations.ts';
import { COMPANY_OBJECT_TYPES, type CompanyObjectType } from './company-layout.ts';
import {
  COMPANY_OBJECT_POLICY_KIND,
  companyVisibilityPolicySetFromPage,
  inferCompanyObjectTypeFromSlug,
  loadCompanyPolicyStorageForObjectMetadata,
  resolveCompanyPathDefaultVisibility,
} from './company-object-policy.ts';
import { resolveCompanyDerivedVisibility, type CompanyDerivedVisibilityResolution } from './company-policy-evaluator.ts';
import { isPageReadableForCompany } from './company-read-filter.ts';
import { parseMarkdown, serializeMarkdown } from './markdown.ts';

export interface PreparedCompanyPutPageContent {
  ok: true;
  enforced: boolean;
  content: string;
  visibility_policy_ids?: string[];
  derived_visibility?: CompanyDerivedVisibilityResolution | null;
}

export interface CompanyWriteAuthorizationFailure {
  ok: false;
  message: string;
}

type ActivePack = { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }> };

const HOSTED_COMPANY_WRITE_ALLOWED_OPERATIONS = new Set(['put_page']);
const HOSTED_COMPANY_UNREVIEWED_SIDE_EFFECT_OPERATIONS = new Set([
  'pause_job',
  'resume_job',
  'replay_job',
  'send_job_message',
]);

export function isHostedCompanyWriteEnforced(ctx: OperationContext): boolean {
  const companyContext = ctx.companyRequestContext;
  return ctx.remote === true
    && companyContext?.identityStatus === 'resolved'
    && companyContext.policyContextAvailable === true;
}

export function hostedCompanyMutatingOperationDenial(
  ctx: OperationContext,
  op: { name: string; mutating?: boolean },
): string | null {
  if (!isHostedCompanyWriteEnforced(ctx)) return null;
  if (HOSTED_COMPANY_WRITE_ALLOWED_OPERATIONS.has(op.name)) return null;
  if (!op.mutating && !HOSTED_COMPANY_UNREVIEWED_SIDE_EFFECT_OPERATIONS.has(op.name)) return null;
  return 'Hosted company write access is not enabled for this tool.';
}

export async function prepareHostedCompanyPutPageContent(
  ctx: OperationContext,
  slug: string,
  content: string,
  opts: { activePack?: ActivePack } = {},
): Promise<PreparedCompanyPutPageContent | CompanyWriteAuthorizationFailure> {
  if (!isHostedCompanyWriteEnforced(ctx)) {
    return { ok: true, enforced: false, content };
  }

  const companyContext = ctx.companyRequestContext!;
  const parsed = parseMarkdown(content, `${slug}.md`, { activePack: opts.activePack });
  const storage = await loadCompanyPolicyStorageForObjectMetadata(ctx.engine);
  if (!storage) return deny();

  const explicitPolicyIds = uniqueStrings([
    ...stringsFromFrontmatter(parsed.frontmatter.visibility_policy_ids),
    ...stringsFromFrontmatter(parsed.frontmatter.visibility_policy_id),
  ]);
  const derivedFrom = stringsFromFrontmatter(parsed.frontmatter.derived_from);
  const evidenceRefs = stringsFromFrontmatter(parsed.frontmatter.evidence_refs);
  const inputRefs = uniqueStrings([...derivedFrom, ...evidenceRefs]);
  const hasDerivedMarkers = hasOwn(parsed.frontmatter, 'derived_from') || hasOwn(parsed.frontmatter, 'evidence_refs');
  const objectType = resolveCompanyObjectType(parsed.type, slug);

  let visibilityPolicyIds: string[];
  let visibilityAssignment: 'preserved_existing' | 'path_default' | 'derived_visibility';
  let visibilityReason: string;
  let derivedVisibility: CompanyDerivedVisibilityResolution | null = null;

  if (inputRefs.length > 0) {
    const inputPolicySets = await readableInputPolicySets(ctx, inputRefs);
    if (!inputPolicySets.ok) return deny();
    derivedVisibility = resolveCompanyDerivedVisibility(inputPolicySets.policySets);
    if (derivedVisibility.decision === 'reject' || derivedVisibility.visibility_policy_ids.length === 0) {
      return deny();
    }
    visibilityPolicyIds = derivedVisibility.visibility_policy_ids;
    visibilityAssignment = 'derived_visibility';
    visibilityReason = derivedVisibility.reason;
  } else if (explicitPolicyIds.length > 0) {
    visibilityPolicyIds = explicitPolicyIds;
    visibilityAssignment = 'preserved_existing';
    visibilityReason = 'explicit_target_policy';
  } else if (hasDerivedMarkers) {
    return deny();
  } else {
    if (!objectType) return deny();
    const pathDefault = resolveCompanyPathDefaultVisibility(storage, objectType, slug);
    visibilityPolicyIds = [pathDefault.visibility_policy_id];
    visibilityAssignment = 'path_default';
    visibilityReason = pathDefault.reason;
  }

  visibilityPolicyIds = uniqueStrings(visibilityPolicyIds);
  if (!canWriteEveryPolicy(companyContext.writablePolicyIds, visibilityPolicyIds)) return deny();

  const existingPage = await ctx.engine.getPage(slug, { sourceId: ctx.sourceId ?? companyContext.sourceId });
  if (existingPage) {
    const existingPolicyIds = companyVisibilityPolicySetFromPage(existingPage);
    if (!canWriteEveryPolicy(companyContext.writablePolicyIds, existingPolicyIds)) return deny();
  }

  const stampedFrontmatter: Record<string, unknown> = {
    ...parsed.frontmatter,
    visibility_policy_id: visibilityPolicyIds[0],
    visibility_policy_ids: visibilityPolicyIds,
    created_by: companyContext.userId,
    derived_from: derivedFrom,
    evidence_refs: evidenceRefs,
    trusted_workspace_artifact: parsed.frontmatter.trusted_workspace_artifact ?? true,
    hosted_company_write: true,
    local_admin_write: false,
    policy_enforcement: 'enforced',
    object_policy_metadata_kind: COMPANY_OBJECT_POLICY_KIND,
    object_policy_enforcement: 'enforced',
    visibility_assignment: visibilityAssignment,
    visibility_assignment_reason: visibilityReason,
    company_policy_decision_id: companyContext.policyDecisionId,
    company_policy_version: companyContext.policyVersion,
    company_policy_hash: companyContext.policyHash,
    company_policy_user_id: companyContext.userId,
    ...(derivedVisibility ? { derived_visibility: derivedVisibility } : {}),
  };

  return {
    ok: true,
    enforced: true,
    content: serializeMarkdown(stampedFrontmatter, parsed.compiled_truth, parsed.timeline, {
      type: parsed.type,
      title: parsed.title,
      tags: parsed.tags,
    }),
    visibility_policy_ids: visibilityPolicyIds,
    derived_visibility: derivedVisibility,
  };
}

async function readableInputPolicySets(
  ctx: OperationContext,
  inputRefs: string[],
): Promise<{ ok: true; policySets: string[][] } | { ok: false }> {
  const companyContext = ctx.companyRequestContext;
  if (!companyContext) return { ok: false };
  const sourceIds = companyContext.allowedSources.length > 0
    ? companyContext.allowedSources
    : [companyContext.sourceId];

  const policySets: string[][] = [];
  for (const ref of inputRefs) {
    let foundReadable = false;
    for (const sourceId of sourceIds) {
      const page = await ctx.engine.getPage(ref, { sourceId });
      if (!page || !isPageReadableForCompany(ctx, page)) continue;
      policySets.push(companyVisibilityPolicySetFromPage(page));
      foundReadable = true;
      break;
    }
    if (!foundReadable) return { ok: false };
  }
  return { ok: true, policySets };
}

function canWriteEveryPolicy(writablePolicyIds: readonly string[], targetPolicyIds: readonly string[]): boolean {
  if (targetPolicyIds.length === 0) return false;
  const writable = new Set(writablePolicyIds);
  return targetPolicyIds.every((policyId) => writable.has(policyId));
}

function resolveCompanyObjectType(type: string, slug: string): CompanyObjectType | null {
  if ((COMPANY_OBJECT_TYPES as readonly string[]).includes(type)) return type as CompanyObjectType;
  return inferCompanyObjectTypeFromSlug(slug);
}

function stringsFromFrontmatter(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value);
}

function uniqueStrings(values: readonly unknown[]): string[] {
  return Array.from(new Set(values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean))).sort();
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function deny(): CompanyWriteAuthorizationFailure {
  return { ok: false, message: 'Company write target is not permitted.' };
}
