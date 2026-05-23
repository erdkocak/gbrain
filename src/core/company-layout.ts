import type { BrainEngine } from './engine.ts';
import {
  COMPANY_METADATA_PLACEHOLDER_FIELDS,
  COMPANY_POLICY_ENFORCEMENT,
  COMPANY_PRIMARY_SOURCE_ID,
} from './company-mode.ts';

export const COMPANY_LAYOUT_VERSION = 1;
export const COMPANY_SCHEMA_PACK_NAME = 'gbrain-company';
export const COMPANY_DEFAULT_POLICY_ID = 'company-trusted-workspace';

export const COMPANY_OBJECT_TYPES = [
  'meeting',
  'doc',
  'decision',
  'commitment',
  'evidence',
  'person',
  'project',
  'action',
] as const;

export type CompanyObjectType = typeof COMPANY_OBJECT_TYPES[number];

export interface CompanyPathDefault {
  object_type: CompanyObjectType;
  page_type: string;
  path_prefix: string;
  slug_pattern: string;
  default_visibility_policy_id: string;
}

export interface CompanyTemplate {
  page_type: string;
  path_prefix: string;
  required_frontmatter: string[];
  optional_frontmatter: string[];
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface CompanyLayoutConfig {
  version: typeof COMPANY_LAYOUT_VERSION;
  schema_pack: typeof COMPANY_SCHEMA_PACK_NAME;
  source_strategy: {
    primary_source_id: string;
    default: 'one_source';
    additional_sources: 'organization_and_routing_only_not_acl_groups';
  };
  path_defaults: CompanyPathDefault[];
  templates: Record<CompanyObjectType, CompanyTemplate>;
  future_policy_seed: {
    policies: Array<{ id: string; label: string; enforcement: typeof COMPANY_POLICY_ENFORCEMENT }>;
    path_defaults: Array<{ path_prefix: string; visibility_policy_id: string }>;
    egress_defaults: {
      external_model: 'disabled_by_default';
      external_web: 'disabled_by_default';
    };
    audit_readers: string[];
  };
}

const COMMON_REQUIRED_FRONTMATTER = [
  'type',
  'title',
  ...COMPANY_METADATA_PLACEHOLDER_FIELDS,
] as const;

const PATH_DEFAULTS: readonly Omit<CompanyPathDefault, 'default_visibility_policy_id'>[] = [
  {
    object_type: 'meeting',
    page_type: 'meeting',
    path_prefix: 'meetings/',
    slug_pattern: 'meetings/YYYY-MM-DD-topic',
  },
  {
    object_type: 'doc',
    page_type: 'doc',
    path_prefix: 'docs/',
    slug_pattern: 'docs/topic-or-source',
  },
  {
    object_type: 'decision',
    page_type: 'decision',
    path_prefix: 'decisions/',
    slug_pattern: 'decisions/YYYY-MM-DD-topic',
  },
  {
    object_type: 'commitment',
    page_type: 'commitment',
    path_prefix: 'commitments/',
    slug_pattern: 'commitments/YYYY-MM-DD-owner-topic',
  },
  {
    object_type: 'evidence',
    page_type: 'evidence',
    path_prefix: 'evidence/',
    slug_pattern: 'evidence/YYYY-MM-DD-source-topic',
  },
  {
    object_type: 'person',
    page_type: 'person',
    path_prefix: 'people/',
    slug_pattern: 'people/name',
  },
  {
    object_type: 'project',
    page_type: 'project',
    path_prefix: 'projects/',
    slug_pattern: 'projects/project-name',
  },
  {
    object_type: 'action',
    page_type: 'action',
    path_prefix: 'actions/',
    slug_pattern: 'actions/YYYY-MM-DD-owner-topic',
  },
];

function baseFrontmatter(pageType: string): Record<string, unknown> {
  return {
    type: pageType,
    title: '',
    visibility_policy_id: null,
    created_by: null,
    derived_from: [],
    evidence_refs: [],
  };
}

function template(
  pageType: string,
  pathPrefix: string,
  specificFrontmatter: Record<string, unknown>,
  optionalFrontmatter: string[],
  body: string,
): CompanyTemplate {
  return {
    page_type: pageType,
    path_prefix: pathPrefix,
    required_frontmatter: [...COMMON_REQUIRED_FRONTMATTER],
    optional_frontmatter: optionalFrontmatter,
    frontmatter: {
      ...baseFrontmatter(pageType),
      ...specificFrontmatter,
    },
    body,
  };
}

export function buildCompanyLayoutConfig(
  primarySourceId = COMPANY_PRIMARY_SOURCE_ID,
): CompanyLayoutConfig {
  const pathDefaults = PATH_DEFAULTS.map((entry) => ({
    ...entry,
    default_visibility_policy_id: COMPANY_DEFAULT_POLICY_ID,
  }));

  return {
    version: COMPANY_LAYOUT_VERSION,
    schema_pack: COMPANY_SCHEMA_PACK_NAME,
    source_strategy: {
      primary_source_id: primarySourceId,
      default: 'one_source',
      additional_sources: 'organization_and_routing_only_not_acl_groups',
    },
    path_defaults: pathDefaults,
    templates: {
      meeting: template('meeting', 'meetings/', {
        event_date: null,
        attendees: [],
        projects: [],
      }, ['summary', 'decisions', 'commitments', 'actions'], '## Summary\n\n## Decisions\n\n## Commitments\n\n## Evidence\n'),
      doc: template('doc', 'docs/', {
        doc_status: 'draft',
        source_ref: null,
        owners: [],
        projects: [],
      }, ['published_at', 'source_url'], '## Summary\n\n## Key Points\n\n## Evidence\n'),
      decision: template('decision', 'decisions/', {
        decision_date: null,
        status: 'proposed',
        owner: null,
        projects: [],
      }, ['deciders', 'alternatives', 'supersedes'], '## Decision\n\n## Context\n\n## Evidence\n\n## Follow Up\n'),
      commitment: template('commitment', 'commitments/', {
        owner: null,
        due_date: null,
        status: 'open',
        projects: [],
      }, ['related_decision', 'accepted_at', 'completed_at'], '## Commitment\n\n## Evidence\n\n## Updates\n'),
      evidence: template('evidence', 'evidence/', {
        evidence_type: 'source',
        source_ref: null,
        captured_at: null,
        supports: [],
      }, ['source_url', 'source_file', 'confidence'], '## Evidence\n\n## Notes\n'),
      person: template('person', 'people/', {
        role: null,
        team: null,
      }, ['email', 'manager', 'projects'], '## Profile\n\n## Responsibilities\n\n## Working Notes\n'),
      project: template('project', 'projects/', {
        status: 'active',
        owners: [],
      }, ['start_date', 'target_date', 'decision_refs'], '## Overview\n\n## Current State\n\n## Decisions\n\n## Actions\n'),
      action: template('action', 'actions/', {
        owner: null,
        due_date: null,
        status: 'open',
        projects: [],
      }, ['source_meeting', 'source_commitment', 'completed_at'], '## Action\n\n## Context\n\n## Evidence\n'),
    },
    future_policy_seed: {
      policies: [{
        id: COMPANY_DEFAULT_POLICY_ID,
        label: 'Company trusted workspace default',
        enforcement: COMPANY_POLICY_ENFORCEMENT,
      }],
      path_defaults: pathDefaults.map((entry) => ({
        path_prefix: entry.path_prefix,
        visibility_policy_id: entry.default_visibility_policy_id,
      })),
      egress_defaults: {
        external_model: 'disabled_by_default',
        external_web: 'disabled_by_default',
      },
      audit_readers: [],
    },
  };
}

export async function applyCompanyLayout(
  engine: BrainEngine,
  layout: CompanyLayoutConfig = buildCompanyLayoutConfig(),
): Promise<CompanyLayoutConfig> {
  await engine.setConfig('company.layout.version', String(layout.version));
  await engine.setConfig('company.layout', JSON.stringify(layout));
  await engine.setConfig('company.layout.path_defaults', JSON.stringify(layout.path_defaults));
  await engine.setConfig('company.layout.templates', JSON.stringify(layout.templates));
  await engine.setConfig('company.layout.policy_seed', JSON.stringify(layout.future_policy_seed));
  await engine.setConfig('company.schema_pack', layout.schema_pack);
  await engine.setConfig('schema_pack', layout.schema_pack);
  await engine.setConfig(`schema_pack.source.${layout.source_strategy.primary_source_id}`, layout.schema_pack);

  await engine.executeRaw(
    `UPDATE sources
        SET config = config || $1::jsonb
      WHERE id = $2`,
    [JSON.stringify({
      company_layout_version: layout.version,
      schema_pack: layout.schema_pack,
      path_defaults: layout.path_defaults,
      one_source_default: true,
      additional_sources_are_acl_groups: false,
    }), layout.source_strategy.primary_source_id],
  );

  return layout;
}
