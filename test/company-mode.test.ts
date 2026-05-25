import { describe, test, expect } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  applyCompanyModeSkeleton,
  buildCompanyModeConfig,
  COMPANY_METADATA_PLACEHOLDER_FIELDS,
} from '../src/core/company-mode.ts';
import {
  COMPANY_HOSTED_ADVISORY_ONLY_SKILLS,
  COMPANY_HOSTED_SKILL_ALLOWLIST,
  COMPANY_HOSTED_SKILL_EXPOSURE,
  classifyCompanyHostedSkill,
} from '../src/core/company-hosted-surface.ts';

describe('company mode skeleton', () => {
  test('buildCompanyModeConfig marks trusted workspace and deferred enforcement', () => {
    const cfg = buildCompanyModeConfig();

    expect(cfg.kind).toBe('company');
    expect(cfg.mode).toBe('trusted_workspace');
    expect(cfg.trusted_workspace).toBe(true);
    expect(cfg.primary_source_id).toBe('company');
    expect(cfg.policy_enforcement).toBe('deferred');
    expect(cfg.security_claim).toBe('none_trusted_workspace_only');
    expect(cfg.hosted_skill_exposure).toBe(COMPANY_HOSTED_SKILL_EXPOSURE);
    expect(cfg.hosted_surface.mode).toBe('reviewed_hosted_mcp_operations_only');
    expect(cfg.hosted_surface.security_claim).toBe('app_layer_permissions_reviewed_tools_only');
    expect(cfg.hosted_surface.mcp_surface.policy_enforcement).toBe('application_layer_reviewed_operations');
    expect(cfg.hosted_surface.skill_gate.default).toBe('deny');
    expect(cfg.hosted_surface.skill_gate.allowlist.map((rule) => rule.name)).toEqual([...COMPANY_HOSTED_SKILL_ALLOWLIST]);
    expect(cfg.hosted_surface.skill_gate.advisory_only).toEqual([...COMPANY_HOSTED_ADVISORY_ONLY_SKILLS]);
    expect(cfg.hosted_surface.disabled_surfaces).toContain('direct_db_credentials_for_normal_secure_users');
    expect(cfg.hosted_surface.disabled_surfaces).toContain('follow_up_external_execution');
    expect(Object.keys(cfg.metadata_placeholders)).toEqual([...COMPANY_METADATA_PLACEHOLDER_FIELDS]);
  });

  test('applyCompanyModeSkeleton creates company source and DB markers', async () => {
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

    const cfg = await applyCompanyModeSkeleton(engine);

    const insert = calls.find((c) => c.sql.includes('INSERT INTO sources'));
    expect(insert).toBeDefined();
    expect(insert!.params[0]).toBe('company');
    expect(insert!.params[1]).toBe('company');
    const sourceConfig = JSON.parse(insert!.params[2] as string);
    expect(sourceConfig.federated).toBe(true);
    expect(sourceConfig.company_primary).toBe(true);
    expect(sourceConfig.trusted_workspace).toBe(true);
    expect(sourceConfig.policy_enforcement).toBe('deferred');
    expect(sourceConfig.metadata_placeholders).toEqual([...COMPANY_METADATA_PLACEHOLDER_FIELDS]);
    expect(sourceConfig.hosted_skill_exposure).toBe(COMPANY_HOSTED_SKILL_EXPOSURE);
    expect(sourceConfig.hosted_surface.skill_gate.default).toBe('deny');
    expect(sourceConfig.hosted_surface.security_claim).toBe('app_layer_permissions_reviewed_tools_only');

    expect(configSet['brain.mode']).toBe('company');
    expect(configSet['company.mode']).toBe('trusted_workspace');
    expect(configSet['company.trusted_workspace']).toBe('true');
    expect(configSet['company.primary_source_id']).toBe('company');
    expect(configSet['company.policy_enforcement']).toBe('deferred');
    expect(configSet['company.security_claim']).toBe('none_trusted_workspace_only');
    expect(JSON.parse(configSet['company.metadata_placeholders'])).toEqual([...COMPANY_METADATA_PLACEHOLDER_FIELDS]);
    expect(configSet['company.hosted_skill_exposure']).toBe(COMPANY_HOSTED_SKILL_EXPOSURE);
    expect(JSON.parse(configSet['company.hosted_surface']).skill_gate.default).toBe('deny');
    expect(JSON.parse(configSet['company.hosted_surface.allowlist'])).toEqual([...COMPANY_HOSTED_SKILL_ALLOWLIST]);
    expect(JSON.parse(configSet['company.hosted_surface.advisory_only'])).toEqual([...COMPANY_HOSTED_ADVISORY_ONLY_SKILLS]);
    expect(JSON.parse(configSet['company.hosted_surface.disabled_surfaces'])).toContain('follow_up_external_execution');
    expect(configSet['sources.default']).toBe('company');
    expect(cfg.primary_source_id).toBe('company');
  });

  test('classifies hosted skills with deny-by-default behavior', () => {
    expect(classifyCompanyHostedSkill('query').decision).toBe('allow');
    const taxonomist = classifyCompanyHostedSkill('brain-taxonomist');
    expect(taxonomist.decision).toBe('allow_advisory');
    expect(taxonomist.advisory_only).toBe(true);

    const denied = classifyCompanyHostedSkill('publish');
    expect(denied.decision).toBe('deny');
    expect(denied.reason).toContain('Denied by default');
  });
});
