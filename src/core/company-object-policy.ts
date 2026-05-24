import type { BrainEngine } from './engine.ts';
import {
  COMPANY_DEFAULT_POLICY_ID,
  COMPANY_OBJECT_TYPES,
  type CompanyObjectType,
} from './company-layout.ts';
import { COMPANY_PRIMARY_SOURCE_ID } from './company-mode.ts';
import {
  type CompanyPolicyStorage,
} from './company-policy.ts';
import {
  type CompanyDerivedVisibilityResolution,
  resolveCompanyDerivedVisibility,
} from './company-policy-evaluator.ts';
import type { Page } from './types.ts';

export const COMPANY_OBJECT_POLICY_KIND = 'company_object_policy_metadata';
export const COMPANY_OBJECT_POLICY_ENFORCEMENT = 'represented_not_enforced';
export const COMPANY_OBJECT_POLICY_SCHEMA_VERSION = 1;

export type CompanyVisibilityAssignment =
  | 'preserved_existing'
  | 'path_default'
  | 'derived_visibility'
  | 'path_default_after_derived_visibility_reject';

export type CompanyVisibilityAssignmentReason =
  | 'existing_visibility_policy_id'
  | 'policy_storage_path_default'
  | 'layout_path_default'
  | 'single_input_inherits'
  | 'multiple_inputs_intersect'
  | 'no_inputs'
  | 'no_input_policies'
  | 'empty_intersection';

export type CompanyRelatedPolicySurface =
  | 'pages'
  | 'content_chunks'
  | 'links'
  | 'timeline_entries'
  | 'facts'
  | 'takes'
  | 'raw_data'
  | 'files'
  | 'synthesis_evidence'
  | 'job_outputs'
  | 'future_audit_rows';

export interface CompanyRelatedPolicyStoragePlan {
  surface: CompanyRelatedPolicySurface;
  current_storage: string;
  assignment_rule: string;
  known_gap: string | null;
}

export interface CompanyObjectPolicyConfig {
  schema_version: typeof COMPANY_OBJECT_POLICY_SCHEMA_VERSION;
  kind: typeof COMPANY_OBJECT_POLICY_KIND;
  enforcement: typeof COMPANY_OBJECT_POLICY_ENFORCEMENT;
  page_metadata_store: 'pages.frontmatter';
  default_policy_id: typeof COMPANY_DEFAULT_POLICY_ID;
  durable_page_fields: ['visibility_policy_id', 'created_by', 'derived_from', 'evidence_refs'];
  path_defaults: Array<{
    object_type: CompanyObjectType;
    path_prefix: string;
    visibility_policy_id: string;
  }>;
  related_storage_plan: CompanyRelatedPolicyStoragePlan[];
}

export interface CompanyObjectVisibilityResolution {
  visibility_policy_id: string;
  visibility_policy_ids: string[];
  assignment: CompanyVisibilityAssignment;
  reason: CompanyVisibilityAssignmentReason;
  derived_visibility: CompanyDerivedVisibilityResolution | null;
}

export interface CompanyObjectPolicyMetadataInput {
  objectType: CompanyObjectType;
  slug: string;
  storage?: CompanyPolicyStorage | null;
  createdBy?: string | null;
  derivedFrom?: readonly string[];
  evidenceRefs?: readonly string[];
  sourceVisibilityPolicyIds?: ReadonlyArray<string | readonly string[] | null | undefined>;
}

const DEFAULT_PATH_PREFIX_BY_OBJECT_TYPE: Record<CompanyObjectType, string> = {
  meeting: 'meetings/',
  doc: 'docs/',
  decision: 'decisions/',
  commitment: 'commitments/',
  evidence: 'evidence/',
  person: 'people/',
  project: 'projects/',
  action: 'actions/',
};

const RELATED_STORAGE_PLAN: CompanyRelatedPolicyStoragePlan[] = [
  {
    surface: 'pages',
    current_storage: 'pages.frontmatter.visibility_policy_id plus created_by, derived_from, evidence_refs',
    assignment_rule: 'Company page writes store object policy metadata directly in page frontmatter.',
    known_gap: null,
  },
  {
    surface: 'content_chunks',
    current_storage: 'content_chunks.page_id -> pages.frontmatter',
    assignment_rule: 'Chunks inherit visibility from their owning page through page_id.',
    known_gap: 'No chunk-level policy column exists yet; permission enforcement must join through pages before retrieval/rerank exposure.',
  },
  {
    surface: 'links',
    current_storage: 'links.from_page_id/to_page_id -> pages.frontmatter; link_source/origin fields are provenance-only',
    assignment_rule: 'Link visibility is derived from the linked pages; derived link outputs use the intersection rule.',
    known_gap: 'No dedicated link policy column exists yet; permission-enforced graph traversal must join both endpoint pages.',
  },
  {
    surface: 'timeline_entries',
    current_storage: 'timeline_entries.page_id -> pages.frontmatter',
    assignment_rule: 'Timeline entries inherit visibility from their owning page.',
    known_gap: 'No timeline-entry policy column exists yet; permission-enforced temporal reads must join through pages.',
  },
  {
    surface: 'facts',
    current_storage: 'facts.source_markdown_slug/source_id and markdown facts fences -> pages.frontmatter',
    assignment_rule: 'Facts inherit visibility from their source markdown page or owning entity page; multi-source derived facts use intersection.',
    known_gap: 'Facts rows do not carry object policy metadata directly yet; permission-enforced fact reads must resolve source/owner page visibility.',
  },
  {
    surface: 'takes',
    current_storage: 'takes source fields and cited pages -> pages.frontmatter',
    assignment_rule: 'Takes inherit/intersect visibility from cited/source pages.',
    known_gap: 'Takes tables do not carry a durable policy id column yet; permission-enforced takes retrieval must resolve through source evidence.',
  },
  {
    surface: 'raw_data',
    current_storage: 'raw_data.page_id -> pages.frontmatter',
    assignment_rule: 'Raw sidecar rows inherit visibility from their owning page.',
    known_gap: 'No raw_data policy column exists yet; permission-enforced sidecar reads must join through pages.',
  },
  {
    surface: 'files',
    current_storage: 'files.metadata plus page_id/page_slug -> pages.frontmatter',
    assignment_rule: 'Files inherit visibility from their attached page; unattached files require explicit metadata before secure exposure.',
    known_gap: 'Existing file rows may be unattached; permission-enforced file APIs must reject or classify unattached files before secure reads.',
  },
  {
    surface: 'synthesis_evidence',
    current_storage: 'derived pages/evidence refs -> pages.frontmatter',
    assignment_rule: 'Synthesis evidence uses the derived visibility rule over every cited input page.',
    known_gap: 'Synthesis-specific policy columns are deferred; permission-enforced derived-memory writers must store the resolved page metadata.',
  },
  {
    surface: 'job_outputs',
    current_storage: 'minion job payloads/artifacts and optional output pages',
    assignment_rule: 'Job outputs that become pages store page frontmatter metadata; non-page artifacts inherit from the request/job policy context.',
    known_gap: 'Minion job rows and attachments do not have a stable object policy column yet; hosted job exposure remains disabled.',
  },
  {
    surface: 'future_audit_rows',
    current_storage: 'not created yet',
    assignment_rule: 'Future audit rows should copy request id, user id, policy decision id, policy version/hash, and target visibility policy id.',
    known_gap: 'Append-only audit storage is audit-hardening work.',
  },
];

export function buildCompanyObjectPolicyConfig(
  storage?: CompanyPolicyStorage | null,
): CompanyObjectPolicyConfig {
  const storageDefaults = (storage?.path_defaults ?? [])
    .filter((entry): entry is { object_type: CompanyObjectType; path_prefix: string; visibility_policy_id: string } => (
      Boolean(entry.object_type)
      && (COMPANY_OBJECT_TYPES as readonly string[]).includes(entry.object_type!)
      && typeof entry.path_prefix === 'string'
      && typeof entry.visibility_policy_id === 'string'
    ))
    .map((entry) => ({
      object_type: entry.object_type,
      path_prefix: entry.path_prefix,
      visibility_policy_id: entry.visibility_policy_id,
    }));
  const coveredObjectTypes = new Set(storageDefaults.map((entry) => entry.object_type));
  const fallbackDefaults = COMPANY_OBJECT_TYPES
    .filter((objectType) => !coveredObjectTypes.has(objectType))
    .map((objectType) => ({
      object_type: objectType,
      path_prefix: DEFAULT_PATH_PREFIX_BY_OBJECT_TYPE[objectType],
      visibility_policy_id: COMPANY_DEFAULT_POLICY_ID,
    }));

  return {
    schema_version: COMPANY_OBJECT_POLICY_SCHEMA_VERSION,
    kind: COMPANY_OBJECT_POLICY_KIND,
    enforcement: COMPANY_OBJECT_POLICY_ENFORCEMENT,
    page_metadata_store: 'pages.frontmatter',
    default_policy_id: COMPANY_DEFAULT_POLICY_ID,
    durable_page_fields: ['visibility_policy_id', 'created_by', 'derived_from', 'evidence_refs'],
    path_defaults: [...storageDefaults, ...fallbackDefaults],
    related_storage_plan: RELATED_STORAGE_PLAN.map((entry) => ({ ...entry })),
  };
}

export async function applyCompanyObjectPolicyConfig(
  engine: BrainEngine,
  storage?: CompanyPolicyStorage | null,
  primarySourceId = COMPANY_PRIMARY_SOURCE_ID,
): Promise<CompanyObjectPolicyConfig> {
  const config = buildCompanyObjectPolicyConfig(storage);
  await engine.setConfig('company.object_policy', JSON.stringify(config));
  await engine.setConfig('company.object_policy.kind', config.kind);
  await engine.setConfig('company.object_policy.enforcement', config.enforcement);
  await engine.setConfig('company.object_policy.path_defaults', JSON.stringify(config.path_defaults));
  await engine.setConfig('company.object_policy.related_storage_plan', JSON.stringify(config.related_storage_plan));

  await engine.executeRaw(
    `UPDATE sources
        SET config = config || $1::jsonb
      WHERE id = $2`,
    [JSON.stringify({
      company_object_policy_kind: config.kind,
      company_object_policy_enforcement: config.enforcement,
      company_object_policy_page_metadata_store: config.page_metadata_store,
      company_object_policy_path_defaults: config.path_defaults,
      company_object_policy_related_storage_plan: config.related_storage_plan,
    }), primarySourceId],
  );

  return config;
}

export async function loadCompanyPolicyStorageForObjectMetadata(
  engine: BrainEngine,
): Promise<CompanyPolicyStorage | null> {
  try {
    const raw = await engine.getConfig('company.policy.storage');
    if (!raw) return null;
    return JSON.parse(raw) as CompanyPolicyStorage;
  } catch {
    return null;
  }
}

export function assignCompanyObjectPolicyMetadata(
  frontmatter: Record<string, unknown>,
  input: CompanyObjectPolicyMetadataInput,
): Record<string, unknown> {
  const resolution = resolveCompanyObjectVisibility(frontmatter, input);
  const createdBy = input.createdBy !== undefined
    ? input.createdBy
    : (frontmatter.created_by ?? null);

  return {
    ...frontmatter,
    visibility_policy_id: resolution.visibility_policy_id,
    visibility_policy_ids: resolution.visibility_policy_ids,
    created_by: createdBy,
    derived_from: input.derivedFrom !== undefined
      ? uniqueStrings(input.derivedFrom)
      : arrayOfStrings(frontmatter.derived_from),
    evidence_refs: input.evidenceRefs !== undefined
      ? uniqueStrings(input.evidenceRefs)
      : arrayOfStrings(frontmatter.evidence_refs),
    trusted_workspace_artifact: frontmatter.trusted_workspace_artifact ?? true,
    policy_enforcement: frontmatter.policy_enforcement ?? 'deferred',
    object_policy_metadata_kind: COMPANY_OBJECT_POLICY_KIND,
    object_policy_enforcement: COMPANY_OBJECT_POLICY_ENFORCEMENT,
    visibility_assignment: resolution.assignment,
    visibility_assignment_reason: resolution.reason,
    ...(resolution.derived_visibility ? { derived_visibility: resolution.derived_visibility } : {}),
  };
}

export function resolveCompanyObjectVisibility(
  frontmatter: Record<string, unknown>,
  input: CompanyObjectPolicyMetadataInput,
): CompanyObjectVisibilityResolution {
  const existingPolicyId = stringOrNull(frontmatter.visibility_policy_id);
  if (existingPolicyId) {
    return {
      visibility_policy_id: existingPolicyId,
      visibility_policy_ids: [existingPolicyId],
      assignment: 'preserved_existing',
      reason: 'existing_visibility_policy_id',
      derived_visibility: null,
    };
  }

  const sourcePolicySets = normalizePolicySets(input.sourceVisibilityPolicyIds ?? []);
  if (sourcePolicySets.length > 0) {
    const derived = resolveCompanyDerivedVisibility(sourcePolicySets);
    if (derived.visibility_policy_ids.length > 0) {
      return {
        visibility_policy_id: derived.visibility_policy_ids[0]!,
        visibility_policy_ids: derived.visibility_policy_ids,
        assignment: 'derived_visibility',
        reason: derived.reason,
        derived_visibility: derived,
      };
    }
    const fallback = resolveCompanyPathDefaultVisibility(input.storage, input.objectType, input.slug);
    return {
      visibility_policy_id: fallback.visibility_policy_id,
      visibility_policy_ids: [fallback.visibility_policy_id],
      assignment: 'path_default_after_derived_visibility_reject',
      reason: derived.reason,
      derived_visibility: derived,
    };
  }

  const pathDefault = resolveCompanyPathDefaultVisibility(input.storage, input.objectType, input.slug);
  return {
    visibility_policy_id: pathDefault.visibility_policy_id,
    visibility_policy_ids: [pathDefault.visibility_policy_id],
    assignment: 'path_default',
    reason: pathDefault.reason,
    derived_visibility: null,
  };
}

export function resolveCompanyPathDefaultVisibility(
  storage: CompanyPolicyStorage | null | undefined,
  objectType: CompanyObjectType,
  slug: string,
): { visibility_policy_id: string; reason: 'policy_storage_path_default' | 'layout_path_default' } {
  const normalizedSlug = slug.trim();
  const defaults = storage?.path_defaults ?? [];
  const match = defaults
    .filter((entry) => {
      if (entry.object_type && entry.object_type !== objectType) return false;
      return normalizedSlug.startsWith(entry.path_prefix);
    })
    .sort((a, b) => {
      const objectWeight = Number(Boolean(b.object_type)) - Number(Boolean(a.object_type));
      if (objectWeight !== 0) return objectWeight;
      return b.path_prefix.length - a.path_prefix.length;
    })[0];

  if (match?.visibility_policy_id) {
    return { visibility_policy_id: match.visibility_policy_id, reason: 'policy_storage_path_default' };
  }

  return { visibility_policy_id: COMPANY_DEFAULT_POLICY_ID, reason: 'layout_path_default' };
}

export function companyVisibilityPolicySetFromPage(page: Page): string[] {
  const ids = arrayOfStrings(page.frontmatter.visibility_policy_ids);
  const single = stringOrNull(page.frontmatter.visibility_policy_id);
  return uniqueStrings([...ids, ...(single ? [single] : [])]);
}

export function inferCompanyObjectTypeFromSlug(slug: string): CompanyObjectType | null {
  const normalized = slug.trim();
  for (const objectType of COMPANY_OBJECT_TYPES) {
    if (normalized.startsWith(DEFAULT_PATH_PREFIX_BY_OBJECT_TYPE[objectType])) return objectType;
  }
  return null;
}

function normalizePolicySets(
  values: ReadonlyArray<string | readonly string[] | null | undefined>,
): string[][] {
  return values.map((value) => {
    if (Array.isArray(value)) return uniqueStrings(value);
    const single = stringOrNull(value);
    return single ? [single] : [];
  });
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value);
}

function uniqueStrings(values: readonly unknown[]): string[] {
  return Array.from(new Set(values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean))).sort();
}
