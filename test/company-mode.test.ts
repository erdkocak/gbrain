import { describe, test, expect } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  applyCompanyModeSkeleton,
  buildCompanyModeConfig,
  COMPANY_METADATA_PLACEHOLDER_FIELDS,
} from '../src/core/company-mode.ts';

describe('company mode skeleton', () => {
  test('buildCompanyModeConfig marks trusted workspace and deferred enforcement', () => {
    const cfg = buildCompanyModeConfig();

    expect(cfg.kind).toBe('company');
    expect(cfg.mode).toBe('trusted_workspace');
    expect(cfg.trusted_workspace).toBe(true);
    expect(cfg.primary_source_id).toBe('company');
    expect(cfg.policy_enforcement).toBe('deferred');
    expect(cfg.security_claim).toBe('none_trusted_workspace_only');
    expect(cfg.hosted_skill_exposure).toBe('not_enabled');
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

    expect(configSet['brain.mode']).toBe('company');
    expect(configSet['company.mode']).toBe('trusted_workspace');
    expect(configSet['company.trusted_workspace']).toBe('true');
    expect(configSet['company.primary_source_id']).toBe('company');
    expect(configSet['company.policy_enforcement']).toBe('deferred');
    expect(configSet['company.security_claim']).toBe('none_trusted_workspace_only');
    expect(JSON.parse(configSet['company.metadata_placeholders'])).toEqual([...COMPANY_METADATA_PLACEHOLDER_FIELDS]);
    expect(configSet['company.hosted_skill_exposure']).toBe('not_enabled');
    expect(configSet['sources.default']).toBe('company');
    expect(cfg.primary_source_id).toBe('company');
  });
});
