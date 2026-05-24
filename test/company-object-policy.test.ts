import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  COMPANY_DEFAULT_POLICY_ID,
  COMPANY_OBJECT_TYPES,
} from '../src/core/company-layout.ts';
import {
  buildCompanyPolicyStorage,
  parseCompanyPolicySeedYaml,
} from '../src/core/company-policy.ts';
import {
  applyCompanyObjectPolicyConfig,
  assignCompanyObjectPolicyMetadata,
  buildCompanyObjectPolicyConfig,
  COMPANY_OBJECT_POLICY_ENFORCEMENT,
  COMPANY_OBJECT_POLICY_KIND,
  inferCompanyObjectTypeFromSlug,
  resolveCompanyObjectVisibility,
  resolveCompanyPathDefaultVisibility,
} from '../src/core/company-object-policy.ts';

function fixtureStorage() {
  return buildCompanyPolicyStorage(parseCompanyPolicySeedYaml(`
version: 1
users:
  - id: alice-example
groups:
  - id: company-pilot-admins
    members:
      - alice-example
policies:
  - id: company-trusted-workspace
    read:
      groups:
        - company-pilot-admins
    write:
      groups:
        - company-pilot-admins
  - id: confidential-docs
    read:
      users:
        - alice-example
path_defaults:
  - object_type: meeting
    path_prefix: meetings/
    visibility_policy_id: company-trusted-workspace
  - object_type: doc
    path_prefix: docs/confidential/
    visibility_policy_id: confidential-docs
  - object_type: doc
    path_prefix: docs/
    visibility_policy_id: company-trusted-workspace
  - object_type: decision
    path_prefix: decisions/
    visibility_policy_id: company-trusted-workspace
  - object_type: commitment
    path_prefix: commitments/
    visibility_policy_id: company-trusted-workspace
  - object_type: evidence
    path_prefix: evidence/
    visibility_policy_id: company-trusted-workspace
  - object_type: person
    path_prefix: people/
    visibility_policy_id: company-trusted-workspace
  - object_type: project
    path_prefix: projects/
    visibility_policy_id: company-trusted-workspace
  - object_type: action
    path_prefix: actions/
    visibility_policy_id: company-trusted-workspace
audit:
  readers:
    groups:
      - company-pilot-admins
`));
}

describe('company object policy metadata defaults', () => {
  test('resolves path defaults for every company object type', () => {
    const storage = fixtureStorage();
    const slugsByType = {
      meeting: 'meetings/2026-05-23-product-sync',
      doc: 'docs/confidential/roadmap',
      decision: 'decisions/2026-05-23-scope',
      commitment: 'commitments/2026-05-23-alice-follow-up',
      evidence: 'evidence/2026-05-23-transcript-product-sync',
      person: 'people/alice-example',
      project: 'projects/company-memory',
      action: 'actions/2026-05-23-alice-send-summary',
    } as const;

    expect(COMPANY_OBJECT_TYPES.map((objectType) => inferCompanyObjectTypeFromSlug(slugsByType[objectType]))).toEqual([...COMPANY_OBJECT_TYPES]);
    expect(resolveCompanyPathDefaultVisibility(storage, 'doc', 'docs/confidential/roadmap')).toEqual({
      visibility_policy_id: 'confidential-docs',
      reason: 'policy_storage_path_default',
    });
    expect(resolveCompanyPathDefaultVisibility(storage, 'doc', 'docs/public-note')).toEqual({
      visibility_policy_id: COMPANY_DEFAULT_POLICY_ID,
      reason: 'policy_storage_path_default',
    });
    expect(resolveCompanyPathDefaultVisibility(null, 'meeting', 'meetings/2026-05-23-product-sync')).toEqual({
      visibility_policy_id: COMPANY_DEFAULT_POLICY_ID,
      reason: 'layout_path_default',
    });
  });

  test('assigns durable page metadata and preserves explicit visibility', () => {
    const storage = fixtureStorage();
    const assigned = assignCompanyObjectPolicyMetadata({
      status: 'captured',
    }, {
      objectType: 'doc',
      slug: 'docs/confidential/roadmap',
      storage,
      createdBy: 'alice-example',
      derivedFrom: ['evidence/source-a'],
      evidenceRefs: ['evidence/source-b', 'evidence/source-a'],
    });

    expect(assigned.visibility_policy_id).toBe('confidential-docs');
    expect(assigned.visibility_policy_ids).toEqual(['confidential-docs']);
    expect(assigned.created_by).toBe('alice-example');
    expect(assigned.derived_from).toEqual(['evidence/source-a']);
    expect(assigned.evidence_refs).toEqual(['evidence/source-a', 'evidence/source-b']);
    expect(assigned.object_policy_metadata_kind).toBe(COMPANY_OBJECT_POLICY_KIND);
    expect(assigned.object_policy_enforcement).toBe(COMPANY_OBJECT_POLICY_ENFORCEMENT);
    expect(assigned.policy_enforcement).toBe('deferred');
    expect(assigned.trusted_workspace_artifact).toBe(true);
    expect(assigned.visibility_assignment).toBe('path_default');

    const preserved = assignCompanyObjectPolicyMetadata({
      visibility_policy_id: 'manually-selected-policy',
      created_by: 'existing-user',
    }, {
      objectType: 'meeting',
      slug: 'meetings/2026-05-23-product-sync',
      storage,
    });
    expect(preserved.visibility_policy_id).toBe('manually-selected-policy');
    expect(preserved.created_by).toBe('existing-user');
    expect(preserved.visibility_assignment).toBe('preserved_existing');
  });

  test('uses derived visibility for extracted objects and falls back when derivation rejects', () => {
    const inherited = resolveCompanyObjectVisibility({}, {
      objectType: 'decision',
      slug: 'decisions/2026-05-23-scope',
      storage: fixtureStorage(),
      sourceVisibilityPolicyIds: [['confidential-docs']],
    });
    expect(inherited.visibility_policy_id).toBe('confidential-docs');
    expect(inherited.assignment).toBe('derived_visibility');
    expect(inherited.reason).toBe('single_input_inherits');
    expect(inherited.derived_visibility?.decision).toBe('inherit');

    const fallback = resolveCompanyObjectVisibility({}, {
      objectType: 'decision',
      slug: 'decisions/2026-05-23-scope',
      storage: fixtureStorage(),
      sourceVisibilityPolicyIds: [['confidential-docs'], ['company-trusted-workspace']],
    });
    expect(fallback.visibility_policy_id).toBe(COMPANY_DEFAULT_POLICY_ID);
    expect(fallback.assignment).toBe('path_default_after_derived_visibility_reject');
    expect(fallback.reason).toBe('empty_intersection');
  });

  test('persists object policy storage plan without claiming enforcement', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const configSet: Record<string, string> = {};
    const engine = {
      setConfig: async (key: string, value: string) => {
        configSet[key] = value;
      },
      executeRaw: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return [];
      },
    } as unknown as BrainEngine;

    const config = await applyCompanyObjectPolicyConfig(engine, fixtureStorage());

    expect(config.kind).toBe(COMPANY_OBJECT_POLICY_KIND);
    expect(config.enforcement).toBe(COMPANY_OBJECT_POLICY_ENFORCEMENT);
    expect(config.path_defaults.length).toBeGreaterThanOrEqual(COMPANY_OBJECT_TYPES.length);
    expect(config.related_storage_plan.map((entry) => entry.surface)).toEqual([
      'pages',
      'content_chunks',
      'links',
      'timeline_entries',
      'facts',
      'takes',
      'raw_data',
      'files',
      'synthesis_evidence',
      'job_outputs',
      'future_audit_rows',
    ]);
    expect(config.related_storage_plan.find((entry) => entry.surface === 'pages')?.known_gap).toBeNull();
    expect(config.related_storage_plan.find((entry) => entry.surface === 'content_chunks')?.known_gap).toContain('No chunk-level policy column');
    expect(JSON.parse(configSet['company.object_policy']!).enforcement).toBe(COMPANY_OBJECT_POLICY_ENFORCEMENT);
    expect(JSON.parse(configSet['company.object_policy.related_storage_plan']!)).toHaveLength(config.related_storage_plan.length);

    const sourcePatch = JSON.parse(calls.find((call) => call.sql.includes('UPDATE sources'))!.params[0] as string);
    expect(sourcePatch.company_object_policy_kind).toBe(COMPANY_OBJECT_POLICY_KIND);
    expect(sourcePatch.company_object_policy_enforcement).toBe(COMPANY_OBJECT_POLICY_ENFORCEMENT);

    const direct = buildCompanyObjectPolicyConfig(fixtureStorage());
    expect(direct.page_metadata_store).toBe('pages.frontmatter');
  });
});
