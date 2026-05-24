import { describe, test, expect } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  applyCompanyLayout,
  buildCompanyLayoutConfig,
  COMPANY_DEFAULT_POLICY_ID,
  COMPANY_OBJECT_TYPES,
  COMPANY_SCHEMA_PACK_NAME,
} from '../src/core/company-layout.ts';
import { loadActivePack } from '../src/core/schema-pack/load-active.ts';
import { inferTypeFromPack } from '../src/core/markdown.ts';

describe('company layout defaults', () => {
  test('declares the company object paths and templates', () => {
    const layout = buildCompanyLayoutConfig();

    expect(layout.version).toBe(1);
    expect(layout.schema_pack).toBe(COMPANY_SCHEMA_PACK_NAME);
    expect(layout.source_strategy.default).toBe('one_source');
    expect(layout.source_strategy.additional_sources).toBe('organization_and_routing_only_not_acl_groups');
    expect(layout.path_defaults.map((entry) => entry.object_type)).toEqual([...COMPANY_OBJECT_TYPES]);
    expect(layout.path_defaults.every((entry) => entry.default_visibility_policy_id === COMPANY_DEFAULT_POLICY_ID)).toBe(true);

    for (const objectType of COMPANY_OBJECT_TYPES) {
      const template = layout.templates[objectType];
      expect(template.frontmatter.type).toBe(template.page_type);
      expect(template.frontmatter.visibility_policy_id).toBeNull();
      expect(template.frontmatter.created_by).toBeNull();
      expect(template.frontmatter.derived_from).toEqual([]);
      expect(template.frontmatter.evidence_refs).toEqual([]);
    }

    expect(layout.future_policy_seed.path_defaults).toHaveLength(COMPANY_OBJECT_TYPES.length);
    expect(layout.future_policy_seed.policies[0].enforcement).toBe('deferred');
    expect(layout.future_policy_seed.egress_defaults.external_model).toBe('disabled_by_default');
  });

  test('persists layout config and source metadata without treating sources as ACL groups', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const configSet: Record<string, string> = {};
    const engine = {
      executeRaw: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return [];
      },
      setConfig: async (key: string, value: string) => {
        configSet[key] = value;
      },
    } as unknown as BrainEngine;

    const layout = await applyCompanyLayout(engine);

    expect(configSet['company.layout.version']).toBe('1');
    expect(JSON.parse(configSet['company.layout']).path_defaults).toHaveLength(COMPANY_OBJECT_TYPES.length);
    expect(JSON.parse(configSet['company.layout.templates']).decision.frontmatter.type).toBe('decision');
    expect(JSON.parse(configSet['company.layout.policy_seed']).path_defaults[0].visibility_policy_id).toBe(COMPANY_DEFAULT_POLICY_ID);
    expect(configSet['company.schema_pack']).toBe(COMPANY_SCHEMA_PACK_NAME);
    expect(configSet['schema_pack']).toBe(COMPANY_SCHEMA_PACK_NAME);
    expect(configSet['schema_pack.source.company']).toBe(COMPANY_SCHEMA_PACK_NAME);

    const update = calls.find((call) => call.sql.includes('UPDATE sources'));
    expect(update).toBeDefined();
    const sourceConfig = JSON.parse(update!.params[0] as string);
    expect(sourceConfig.path_defaults).toHaveLength(COMPANY_OBJECT_TYPES.length);
    expect(sourceConfig.one_source_default).toBe(true);
    expect(sourceConfig.additional_sources_are_acl_groups).toBe(false);
    expect(layout.schema_pack).toBe(COMPANY_SCHEMA_PACK_NAME);
  });

  test('bundled gbrain-company pack infers company page types from paths', async () => {
    const pack = await loadActivePack({
      cfg: { engine: 'pglite', schema_pack: COMPANY_SCHEMA_PACK_NAME },
      remote: false,
    });
    const activePack = { page_types: pack.manifest.page_types };

    expect(pack.manifest.name).toBe(COMPANY_SCHEMA_PACK_NAME);
    expect(inferTypeFromPack('meetings/2026-05-23-product-sync.md', activePack)).toBe('meeting');
    expect(inferTypeFromPack('docs/search-refresh.md', activePack)).toBe('doc');
    expect(inferTypeFromPack('decisions/2026-05-23-scope.md', activePack)).toBe('decision');
    expect(inferTypeFromPack('commitments/2026-05-23-owner-follow-up.md', activePack)).toBe('commitment');
    expect(inferTypeFromPack('evidence/2026-05-23-transcript.md', activePack)).toBe('evidence');
    expect(inferTypeFromPack('people/alice-example.md', activePack)).toBe('person');
    expect(inferTypeFromPack('projects/search-refresh.md', activePack)).toBe('project');
    expect(inferTypeFromPack('actions/2026-05-23-send-follow-up.md', activePack)).toBe('action');
  });
});
