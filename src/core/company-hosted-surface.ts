import type { BrainEngine } from './engine.ts';

export const COMPANY_HOSTED_SURFACE_VERSION = 1;
export const COMPANY_HOSTED_SKILL_EXPOSURE = 'deny_by_default_trusted_pilot';

export const COMPANY_HOSTED_SKILL_ALLOWLIST = [
  'query',
  'briefing',
  'daily-task-prep',
  'ask-user',
  'repo-architecture',
  'brain-taxonomist',
] as const;

export const COMPANY_HOSTED_ADVISORY_ONLY_SKILLS = [
  'brain-taxonomist',
] as const;

export const COMPANY_HOSTED_DISABLED_SURFACES = [
  'hosted_writes_for_normal_users',
  'direct_db_credentials_for_normal_secure_users',
  'code_intelligence_reads',
  'analytics_reads',
  'maintenance_dream_cycle_automation',
  'publishing_export',
  'external_research_and_model_egress',
  'minion_subagent_orchestration',
  'cron_webhook_connectors',
  'skill_mutation',
  'follow_up_external_execution',
] as const;

export type CompanyHostedSkillName = typeof COMPANY_HOSTED_SKILL_ALLOWLIST[number];
export type CompanyHostedSkillDecision = 'allow' | 'allow_advisory' | 'deny';

export interface CompanyHostedSkillRule {
  name: string;
  decision: CompanyHostedSkillDecision;
  trusted_pilot_only: boolean;
  advisory_only: boolean;
  reason: string;
}

export interface CompanyHostedSurfaceConfig {
  version: typeof COMPANY_HOSTED_SURFACE_VERSION;
  mode: 'trusted_pilot_clients_only';
  security_claim: 'none_trusted_workspace_only';
  normal_secure_users: 'not_supported_until_permission_enforcement';
  direct_db_credentials: 'admin_development_only_not_for_normal_secure_users';
  mcp_surface: {
    clients: 'trusted_company_workspace_pilot_clients_only';
    writes: 'disabled_for_normal_hosted_users';
    policy_enforcement: 'deferred';
  };
  skill_gate: {
    default: 'deny';
    exposure: typeof COMPANY_HOSTED_SKILL_EXPOSURE;
    allowlist: CompanyHostedSkillRule[];
    advisory_only: typeof COMPANY_HOSTED_ADVISORY_ONLY_SKILLS[number][];
  };
  disabled_surfaces: typeof COMPANY_HOSTED_DISABLED_SURFACES[number][];
}

export function buildCompanyHostedSurfaceConfig(): CompanyHostedSurfaceConfig {
  const advisory = new Set<string>(COMPANY_HOSTED_ADVISORY_ONLY_SKILLS);
  return {
    version: COMPANY_HOSTED_SURFACE_VERSION,
    mode: 'trusted_pilot_clients_only',
    security_claim: 'none_trusted_workspace_only',
    normal_secure_users: 'not_supported_until_permission_enforcement',
    direct_db_credentials: 'admin_development_only_not_for_normal_secure_users',
    mcp_surface: {
      clients: 'trusted_company_workspace_pilot_clients_only',
      writes: 'disabled_for_normal_hosted_users',
      policy_enforcement: 'deferred',
    },
    skill_gate: {
      default: 'deny',
      exposure: COMPANY_HOSTED_SKILL_EXPOSURE,
      allowlist: COMPANY_HOSTED_SKILL_ALLOWLIST.map((name) => ({
        name,
        decision: advisory.has(name) ? 'allow_advisory' : 'allow',
        trusted_pilot_only: true,
        advisory_only: advisory.has(name),
        reason: advisory.has(name)
          ? 'Allowed only as a filing/taxonomy advisory skill; writes still require later policy enforcement.'
          : 'Allowed for trusted full-reader company pilot clients only.',
      })),
      advisory_only: [...COMPANY_HOSTED_ADVISORY_ONLY_SKILLS],
    },
    disabled_surfaces: [...COMPANY_HOSTED_DISABLED_SURFACES],
  };
}

export function classifyCompanyHostedSkill(skillName: string): CompanyHostedSkillRule {
  const config = buildCompanyHostedSurfaceConfig();
  const exact = config.skill_gate.allowlist.find((rule) => rule.name === skillName);
  if (exact) return exact;
  return {
    name: skillName,
    decision: 'deny',
    trusted_pilot_only: true,
    advisory_only: false,
    reason: 'Denied by default until the skill is reviewed, rewritten, or explicitly allowlisted for the trusted company pilot.',
  };
}

export async function applyCompanyHostedSurface(
  engine: BrainEngine,
  primarySourceId: string,
  config: CompanyHostedSurfaceConfig = buildCompanyHostedSurfaceConfig(),
): Promise<CompanyHostedSurfaceConfig> {
  await engine.setConfig('company.hosted_skill_exposure', COMPANY_HOSTED_SKILL_EXPOSURE);
  await engine.setConfig('company.hosted_surface', JSON.stringify(config));
  await engine.setConfig('company.hosted_surface.mode', config.mode);
  await engine.setConfig('company.hosted_surface.skill_gate', JSON.stringify(config.skill_gate));
  await engine.setConfig('company.hosted_surface.allowlist', JSON.stringify(COMPANY_HOSTED_SKILL_ALLOWLIST));
  await engine.setConfig('company.hosted_surface.advisory_only', JSON.stringify(COMPANY_HOSTED_ADVISORY_ONLY_SKILLS));
  await engine.setConfig('company.hosted_surface.disabled_surfaces', JSON.stringify(config.disabled_surfaces));

  await engine.executeRaw(
    `UPDATE sources
        SET config = config || $1::jsonb
      WHERE id = $2`,
    [JSON.stringify({
      hosted_skill_exposure: COMPANY_HOSTED_SKILL_EXPOSURE,
      hosted_surface: config,
    }), primarySourceId],
  );

  return config;
}
