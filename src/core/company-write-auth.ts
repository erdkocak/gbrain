import type { OperationContext } from './operations.ts';
import { COMPANY_OBJECT_TYPES, type CompanyObjectType } from './company-layout.ts';
import { hashCompanyAuditPolicyIds, hashCompanyAuditValue } from './company-audit.ts';
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
import type { Page } from './types.ts';

export interface CompanyHostedWriteAuditMetadata {
  target_slug: string;
  target_source_id: string | null;
  target_policy_ids: string[];
  target_policy_ids_hash: string | null;
  existing_policy_ids: string[];
  existing_policy_ids_hash: string | null;
  input_object_ids_or_slugs: string[];
  derived_from: string[];
  evidence_refs: string[];
  submitted_content_hash: string;
  before_content_hash: string | null;
  after_content_hash: string | null;
  visibility_assignment: 'preserved_existing' | 'path_default' | 'derived_visibility' | 'unresolved';
  visibility_assignment_reason: string | null;
  derived_visibility_attempted: boolean;
  derived_visibility_status: 'not_applicable' | 'succeeded' | 'denied';
  derived_visibility_reason: CompanyDerivedVisibilityResolution['reason'] | 'input_unreadable' | null;
  derived_visibility: CompanyDerivedVisibilityResolution | null;
  policy_reclassification_attempted: boolean;
  overwrite: boolean;
  policy_decision_id: string | null;
  denial_reason: string | null;
}

export interface PreparedCompanyPutPageContent {
  ok: true;
  enforced: boolean;
  content: string;
  visibility_policy_ids?: string[];
  derived_visibility?: CompanyDerivedVisibilityResolution | null;
  audit?: CompanyHostedWriteAuditMetadata;
}

export interface CompanyWriteAuthorizationFailure {
  ok: false;
  message: string;
  audit?: CompanyHostedWriteAuditMetadata;
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
  const targetSourceId = ctx.sourceId ?? companyContext.sourceId ?? null;
  const submittedContentHash = hashCompanyAuditValue(content);
  const parsed = parseMarkdown(content, `${slug}.md`, { activePack: opts.activePack });
  const storage = await loadCompanyPolicyStorageForObjectMetadata(ctx.engine);

  const explicitPolicyIds = uniqueStrings([
    ...stringsFromFrontmatter(parsed.frontmatter.visibility_policy_ids),
    ...stringsFromFrontmatter(parsed.frontmatter.visibility_policy_id),
  ]);
  const derivedFrom = stringsFromFrontmatter(parsed.frontmatter.derived_from);
  const evidenceRefs = stringsFromFrontmatter(parsed.frontmatter.evidence_refs);
  const inputRefs = uniqueStrings([...derivedFrom, ...evidenceRefs]);
  const hasDerivedMarkers = hasOwn(parsed.frontmatter, 'derived_from') || hasOwn(parsed.frontmatter, 'evidence_refs');
  const objectType = resolveCompanyObjectType(parsed.type, slug);
  const existingPage = await ctx.engine.getPage(slug, { sourceId: ctx.sourceId ?? companyContext.sourceId });
  const existingPolicyIds = existingPage ? companyVisibilityPolicySetFromPage(existingPage) : [];
  const beforeContentHash = existingPage ? hashCompanyAuditValue(pageAuditContent(existingPage)) : null;

  let visibilityPolicyIds: string[] = [];
  let visibilityAssignment: CompanyHostedWriteAuditMetadata['visibility_assignment'] = 'unresolved';
  let visibilityReason: string | null = null;
  let derivedVisibility: CompanyDerivedVisibilityResolution | null = null;
  let derivedVisibilityStatus: CompanyHostedWriteAuditMetadata['derived_visibility_status'] = hasDerivedMarkers || inputRefs.length > 0
    ? 'denied'
    : 'not_applicable';
  let derivedVisibilityReason: CompanyHostedWriteAuditMetadata['derived_visibility_reason'] = null;

  const buildAudit = (overrides: Partial<CompanyHostedWriteAuditMetadata> = {}): CompanyHostedWriteAuditMetadata => {
    const targetPolicyIds = uniqueStrings(overrides.target_policy_ids ?? visibilityPolicyIds);
    const existingIds = uniqueStrings(overrides.existing_policy_ids ?? existingPolicyIds);
    return {
      target_slug: slug,
      target_source_id: targetSourceId,
      target_policy_ids: targetPolicyIds,
      target_policy_ids_hash: hashCompanyAuditPolicyIds(targetPolicyIds),
      existing_policy_ids: existingIds,
      existing_policy_ids_hash: hashCompanyAuditPolicyIds(existingIds),
      input_object_ids_or_slugs: inputRefs,
      derived_from: derivedFrom,
      evidence_refs: evidenceRefs,
      submitted_content_hash: submittedContentHash,
      before_content_hash: beforeContentHash,
      after_content_hash: null,
      visibility_assignment: visibilityAssignment,
      visibility_assignment_reason: visibilityReason,
      derived_visibility_attempted: hasDerivedMarkers || inputRefs.length > 0,
      derived_visibility_status: derivedVisibilityStatus,
      derived_visibility_reason: derivedVisibilityReason,
      derived_visibility: derivedVisibility,
      policy_reclassification_attempted: existingPage !== null
        && targetPolicyIds.length > 0
        && !sameStringSet(existingIds, targetPolicyIds),
      overwrite: existingPage !== null,
      policy_decision_id: companyContext.policyDecisionId ?? null,
      denial_reason: null,
      ...overrides,
    };
  };

  const deny = (reason: NonNullable<CompanyHostedWriteAuditMetadata['denial_reason']>) => ({
    ok: false as const,
    message: 'Company write target is not permitted.',
    audit: buildAudit({ denial_reason: reason }),
  });

  if (!storage) return deny('missing_policy_storage');

  if (inputRefs.length > 0) {
    const inputPolicySets = await readableInputPolicySets(ctx, inputRefs);
    if (!inputPolicySets.ok) {
      derivedVisibilityStatus = 'denied';
      derivedVisibilityReason = inputPolicySets.reason;
      return deny(`derived_visibility_${inputPolicySets.reason}`);
    }
    derivedVisibility = resolveCompanyDerivedVisibility(inputPolicySets.policySets);
    derivedVisibilityReason = derivedVisibility.reason;
    if (derivedVisibility.decision === 'reject' || derivedVisibility.visibility_policy_ids.length === 0) {
      derivedVisibilityStatus = 'denied';
      return deny(`derived_visibility_${derivedVisibility.reason}`);
    }
    derivedVisibilityStatus = 'succeeded';
    visibilityPolicyIds = derivedVisibility.visibility_policy_ids;
    visibilityAssignment = 'derived_visibility';
    visibilityReason = derivedVisibility.reason;
  } else if (explicitPolicyIds.length > 0) {
    visibilityPolicyIds = explicitPolicyIds;
    visibilityAssignment = 'preserved_existing';
    visibilityReason = 'explicit_target_policy';
  } else if (hasDerivedMarkers) {
    derivedVisibilityStatus = 'denied';
    derivedVisibilityReason = 'no_inputs';
    return deny('derived_visibility_no_inputs');
  } else {
    if (!objectType) return deny('target_object_type_unresolved');
    const pathDefault = resolveCompanyPathDefaultVisibility(storage, objectType, slug);
    visibilityPolicyIds = [pathDefault.visibility_policy_id];
    visibilityAssignment = 'path_default';
    visibilityReason = pathDefault.reason;
  }

  visibilityPolicyIds = uniqueStrings(visibilityPolicyIds);
  if (!canWriteEveryPolicy(companyContext.writablePolicyIds, visibilityPolicyIds)) return deny('target_policy_not_writable');
  if (existingPage && !canWriteEveryPolicy(companyContext.writablePolicyIds, existingPolicyIds)) {
    return deny('existing_policy_not_writable');
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
  const stampedContent = serializeMarkdown(stampedFrontmatter, parsed.compiled_truth, parsed.timeline, {
    type: parsed.type,
    title: parsed.title,
    tags: parsed.tags,
  });

  return {
    ok: true,
    enforced: true,
    content: stampedContent,
    visibility_policy_ids: visibilityPolicyIds,
    derived_visibility: derivedVisibility,
    audit: buildAudit({
      after_content_hash: hashCompanyAuditValue(stampedContent),
    }),
  };
}

async function readableInputPolicySets(
  ctx: OperationContext,
  inputRefs: string[],
): Promise<
  | { ok: true; policySets: string[][] }
  | { ok: false; reason: 'input_unreadable' | 'no_input_policies' }
> {
  const companyContext = ctx.companyRequestContext;
  if (!companyContext) return { ok: false, reason: 'input_unreadable' };
  const sourceIds = companyContext.allowedSources.length > 0
    ? companyContext.allowedSources
    : [companyContext.sourceId];

  const policySets: string[][] = [];
  for (const ref of inputRefs) {
    let foundReadable = false;
    let foundNoPolicy = false;
    for (const sourceId of sourceIds) {
      const page = await ctx.engine.getPage(ref, { sourceId });
      if (!page) continue;
      const policySet = companyVisibilityPolicySetFromPage(page);
      if (policySet.length === 0) {
        foundNoPolicy = true;
        continue;
      }
      if (!isPageReadableForCompany(ctx, page)) continue;
      policySets.push(policySet);
      foundReadable = true;
      break;
    }
    if (!foundReadable) return { ok: false, reason: foundNoPolicy ? 'no_input_policies' : 'input_unreadable' };
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

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const bSet = new Set(b);
  return a.every((entry) => bSet.has(entry));
}

function pageAuditContent(page: Page): string {
  return serializeMarkdown(page.frontmatter, page.compiled_truth, page.timeline || '', {
    type: page.type,
    title: page.title,
    tags: [],
  });
}
