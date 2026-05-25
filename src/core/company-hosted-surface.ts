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

export const COMPANY_HOSTED_SKILL_TOOL_REQUIREMENTS = {
  query: ['query'],
  briefing: ['search', 'query', 'get_page', 'list_pages', 'get_timeline'],
  'daily-task-prep': ['search', 'query', 'get_page', 'list_pages', 'get_timeline'],
  'ask-user': [],
  'repo-architecture': ['search', 'get_page', 'list_pages'],
  'brain-taxonomist': ['search', 'get_page', 'list_pages'],
} as const;

export const COMPANY_HOSTED_SUPPORT_TOOL_ALLOWLIST = [
  'whoami',
] as const;

export const COMPANY_HOSTED_REVIEWED_DIRECT_TOOL_ALLOWLIST = [
  'put_page',
  'resolve_slugs',
  'get_chunks',
  'get_versions',
  'get_raw_data',
  'get_ingest_log',
  'takes_list',
  'takes_search',
  'recall',
  'find_trajectory',
  'get_links',
  'get_backlinks',
  'traverse_graph',
  'code_callers',
  'code_callees',
  'code_def',
  'code_refs',
  'code_blast',
  'code_flow',
] as const;

export const COMPANY_HOSTED_DISABLED_SURFACES = [
  'hosted_writes_for_normal_users',
  'direct_db_credentials_for_normal_secure_users',
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
export type CompanyHostedToolDecision = 'allow' | 'deny';

export interface CompanyHostedSkillRule {
  name: string;
  decision: CompanyHostedSkillDecision;
  trusted_pilot_only: boolean;
  advisory_only: boolean;
  reason: string;
}

export interface CompanyHostedToolRule {
  name: string;
  decision: CompanyHostedToolDecision;
  reviewed: boolean;
  source: 'hosted_skill' | 'support' | 'reviewed_direct';
  skills: string[];
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
  tool_gate: {
    default: 'deny';
    reviewed_tools: CompanyHostedToolRule[];
    no_external_execution: true;
  };
  disabled_surfaces: typeof COMPANY_HOSTED_DISABLED_SURFACES[number][];
}

export function buildCompanyHostedSurfaceConfig(): CompanyHostedSurfaceConfig {
  const advisory = new Set<string>(COMPANY_HOSTED_ADVISORY_ONLY_SKILLS);
  const skillRules = COMPANY_HOSTED_SKILL_ALLOWLIST.map((name) => ({
    name,
    decision: advisory.has(name) ? 'allow_advisory' as const : 'allow' as const,
    trusted_pilot_only: true,
    advisory_only: advisory.has(name),
    reason: advisory.has(name)
      ? 'Allowed only as a filing/taxonomy advisory skill; writes require separate policy-enforced operation authorization.'
      : 'Allowed for trusted full-reader company pilot clients only.',
  }));
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
      allowlist: skillRules,
      advisory_only: [...COMPANY_HOSTED_ADVISORY_ONLY_SKILLS],
    },
    tool_gate: {
      default: 'deny',
      reviewed_tools: buildCompanyHostedToolRules(skillRules),
      no_external_execution: true,
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

export function buildCompanyHostedToolRules(
  skillRules: readonly CompanyHostedSkillRule[] = buildCompanyHostedSurfaceConfig().skill_gate.allowlist,
): CompanyHostedToolRule[] {
  const rules = new Map<string, CompanyHostedToolRule>();

  for (const skill of skillRules) {
    if (skill.decision === 'deny') continue;
    const tools = COMPANY_HOSTED_SKILL_TOOL_REQUIREMENTS[skill.name as CompanyHostedSkillName] ?? [];
    for (const tool of tools) {
      const existing = rules.get(tool);
      if (existing) {
        existing.skills = [...new Set([...existing.skills, skill.name])].sort();
        continue;
      }
      rules.set(tool, {
        name: tool,
        decision: 'allow',
        reviewed: true,
        source: 'hosted_skill',
        skills: [skill.name],
        reason: 'Required by an allowlisted hosted company skill and routed through permission-enforced operations.',
      });
    }
  }

  for (const tool of COMPANY_HOSTED_SUPPORT_TOOL_ALLOWLIST) {
    rules.set(tool, {
      name: tool,
      decision: 'allow',
      reviewed: true,
      source: 'support',
      skills: [],
      reason: 'Support tool for hosted company clients; does not expose brain object content.',
    });
  }

  for (const tool of COMPANY_HOSTED_REVIEWED_DIRECT_TOOL_ALLOWLIST) {
    rules.set(tool, {
      name: tool,
      decision: 'allow',
      reviewed: true,
      source: 'reviewed_direct',
      skills: [],
      reason: 'Reviewed direct hosted company operation with permission enforcement.',
    });
  }

  return [...rules.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function classifyCompanyHostedTool(
  toolName: string,
  config: CompanyHostedSurfaceConfig = buildCompanyHostedSurfaceConfig(),
): CompanyHostedToolRule {
  const exact = config.tool_gate.reviewed_tools.find((rule) => rule.name === toolName);
  if (exact) return exact;
  return {
    name: toolName,
    decision: 'deny',
    reviewed: false,
    source: 'hosted_skill',
    skills: [],
    reason: 'Denied by default until the tool is reviewed and routed through hosted company permission enforcement.',
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
  await engine.setConfig('company.hosted_surface.tool_gate', JSON.stringify(config.tool_gate));
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
