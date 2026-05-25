import type { BrainEngine } from './engine.ts';
import type { Operation, OperationContext } from './operations.ts';
import {
  buildCompanyHostedSurfaceConfig,
  classifyCompanyHostedTool,
  type CompanyHostedSurfaceConfig,
} from './company-hosted-surface.ts';

export const COMPANY_HOSTED_TOOL_GATE_DENIAL =
  'Hosted company tool is not enabled.';

export function isHostedCompanyToolGateActive(ctx: OperationContext): boolean {
  const companyContext = ctx.companyRequestContext;
  return ctx.remote === true
    && companyContext?.identityStatus === 'resolved'
    && companyContext.policyContextAvailable === true;
}

export async function filterHostedCompanyOperations(
  ctx: OperationContext,
  operations: readonly Operation[],
): Promise<Operation[]> {
  if (!isHostedCompanyToolGateActive(ctx)) return [...operations];
  const allowedTools = await allowedHostedCompanyToolNames(ctx.engine);
  return operations.filter((op) => allowedTools.has(op.name));
}

export async function hostedCompanyToolAccessDenial(
  ctx: OperationContext,
  op: Operation,
): Promise<string | null> {
  if (!isHostedCompanyToolGateActive(ctx)) return null;
  const allowedTools = await allowedHostedCompanyToolNames(ctx.engine);
  if (allowedTools.has(op.name)) return null;
  return COMPANY_HOSTED_TOOL_GATE_DENIAL;
}

export async function allowedHostedCompanyToolNames(engine: BrainEngine): Promise<Set<string>> {
  const config = await loadCompanyHostedSurfaceConfig(engine);
  if (!config || config.skill_gate.default !== 'deny' || config.tool_gate.default !== 'deny') {
    return new Set();
  }
  return new Set(
    config.tool_gate.reviewed_tools
      .filter((rule) => rule.decision === 'allow' && rule.reviewed)
      .map((rule) => rule.name),
  );
}

export async function loadCompanyHostedSurfaceConfig(
  engine: BrainEngine,
): Promise<CompanyHostedSurfaceConfig | null> {
  let raw: string | null;
  try {
    raw = await engine.getConfig('company.hosted_surface');
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CompanyHostedSurfaceConfig>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.tool_gate) {
      const fallback = buildCompanyHostedSurfaceConfig();
      return {
        ...fallback,
        ...parsed,
        skill_gate: parsed.skill_gate ?? fallback.skill_gate,
        tool_gate: fallback.tool_gate,
        disabled_surfaces: parsed.disabled_surfaces ?? fallback.disabled_surfaces,
      };
    }
    return parsed as CompanyHostedSurfaceConfig;
  } catch {
    return null;
  }
}

export async function classifyHostedCompanyToolForEngine(
  engine: BrainEngine,
  toolName: string,
) {
  const config = await loadCompanyHostedSurfaceConfig(engine);
  if (!config) return classifyCompanyHostedTool(toolName, buildCompanyHostedSurfaceConfig());
  return classifyCompanyHostedTool(toolName, config);
}
