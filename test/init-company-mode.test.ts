import { describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO_ROOT = join(import.meta.dir, '..');
const CLI = join(REPO_ROOT, 'src', 'cli.ts');

async function runCli(args: string[], gbrainHome: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.GBRAIN_HOME = gbrainHome;
  delete env.DATABASE_URL;
  delete env.GBRAIN_DATABASE_URL;
  delete env.OPENAI_API_KEY;
  delete env.ZEROENTROPY_API_KEY;
  delete env.VOYAGE_API_KEY;

  const proc = Bun.spawn({
    cmd: ['bun', 'run', CLI, ...args],
    cwd: REPO_ROOT,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function lastJsonLine(stdout: string): any {
  const lines = stdout.split('\n').filter((line) => line.trim().startsWith('{'));
  expect(lines.length).toBeGreaterThan(0);
  return JSON.parse(lines[lines.length - 1]);
}

describe('gbrain init --company', () => {
  test('persists trusted-workspace marker and makes company the default source', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-init-company-'));
    try {
      const init = await runCli(['init', '--company', '--pglite', '--no-embedding', '--json'], home);
      expect(init.exitCode).toBe(0);
      const parsed = lastJsonLine(init.stdout);
      expect(parsed.status).toBe('success');
      expect(parsed.company.mode).toBe('trusted_workspace');
      expect(parsed.company.policy_enforcement).toBe('deferred');
      expect(parsed.company.hosted_skill_exposure).toBe('deny_by_default_trusted_pilot');
      expect(parsed.company.hosted_surface.mode).toBe('trusted_pilot_clients_only');
      expect(parsed.company.hosted_surface.skill_gate.default).toBe('deny');
      expect(parsed.company.hosted_surface.skill_gate.allowlist.map((entry: any) => entry.name)).toEqual([
        'query',
        'briefing',
        'daily-task-prep',
        'ask-user',
        'repo-architecture',
        'brain-taxonomist',
      ]);
      expect(parsed.company.hosted_surface.skill_gate.advisory_only).toEqual(['brain-taxonomist']);
      expect(parsed.company.policy.seed.policies[0].id).toBe('company-trusted-workspace');
      expect(parsed.company.policy.metadata.enforcement).toBe('not_enforced_stage_2a');
      expect(parsed.company.policy.metadata.default_decision).toBe('deny');
      expect(parsed.company.object_policy.stage).toBe('stage_2d_object_metadata_not_enforced');
      expect(parsed.company.object_policy.enforcement).toBe('not_enforced_stage_2d');
      expect(parsed.company.object_policy.page_metadata_store).toBe('pages.frontmatter');
      expect(parsed.company.metadata_placeholders.visibility_policy_id).toBeNull();
      expect(parsed.company.schema_pack).toBe('gbrain-company');
      expect(parsed.company.layout.path_defaults.map((entry: any) => entry.object_type)).toEqual([
        'meeting',
        'doc',
        'decision',
        'commitment',
        'evidence',
        'person',
        'project',
        'action',
      ]);

      const cfg = JSON.parse(readFileSync(join(home, '.gbrain', 'config.json'), 'utf-8'));
      expect(cfg.schema_pack).toBe('gbrain-company');
      expect(cfg.company.mode).toBe('trusted_workspace');
      expect(cfg.company.primary_source_id).toBe('company');
      expect(cfg.company.schema_pack).toBe('gbrain-company');
      expect(cfg.company.layout.templates.decision.frontmatter.type).toBe('decision');
      expect(cfg.company.policy_enforcement).toBe('deferred');
      expect(cfg.company.security_claim).toBe('none_trusted_workspace_only');
      expect(cfg.company.hosted_skill_exposure).toBe('deny_by_default_trusted_pilot');
      expect(cfg.company.hosted_surface.disabled_surfaces).toContain('direct_db_credentials_for_normal_secure_users');
      expect(cfg.company.hosted_surface.disabled_surfaces).toContain('follow_up_external_execution');
      expect(cfg.company.policy.seed.path_defaults[0].visibility_policy_id).toBe('company-trusted-workspace');
      expect(cfg.company.policy.metadata.enforcement).toBe('not_enforced_stage_2a');
      expect(cfg.company.object_policy.related_storage_plan.map((entry: any) => entry.surface)).toContain('content_chunks');

      const mode = await runCli(['config', 'get', 'company.mode'], home);
      expect(mode.exitCode).toBe(0);
      expect(mode.stdout.trim()).toBe('trusted_workspace');

      const defaultSource = await runCli(['config', 'get', 'sources.default'], home);
      expect(defaultSource.exitCode).toBe(0);
      expect(defaultSource.stdout.trim()).toBe('company');

      const schemaPack = await runCli(['config', 'get', 'schema_pack'], home);
      expect(schemaPack.exitCode).toBe(0);
      expect(schemaPack.stdout.trim()).toBe('gbrain-company');

      const hostedSurface = await runCli(['config', 'get', 'company.hosted_surface'], home);
      expect(hostedSurface.exitCode).toBe(0);
      expect(JSON.parse(hostedSurface.stdout).skill_gate.default).toBe('deny');

      const hostedSurfaceCommand = await runCli(['company', 'hosted-surface', '--json'], home);
      expect(hostedSurfaceCommand.exitCode).toBe(0);
      expect(JSON.parse(hostedSurfaceCommand.stdout).skill_gate.allowlist.map((entry: any) => entry.name)).toContain('query');

      const policySeed = await runCli(['config', 'get', 'company.policy.seed'], home);
      expect(policySeed.exitCode).toBe(0);
      expect(JSON.parse(policySeed.stdout).policies[0].id).toBe('company-trusted-workspace');

      const policyStorage = await runCli(['config', 'get', 'company.policy.storage'], home);
      expect(policyStorage.exitCode).toBe(0);
      expect(JSON.parse(policyStorage.stdout).default_decision).toBe('deny');

      const policyEnforcement = await runCli(['config', 'get', 'company.policy.enforcement'], home);
      expect(policyEnforcement.exitCode).toBe(0);
      expect(policyEnforcement.stdout.trim()).toBe('not_enforced_stage_2a');

      const objectPolicy = await runCli(['config', 'get', 'company.object_policy'], home);
      expect(objectPolicy.exitCode).toBe(0);
      expect(JSON.parse(objectPolicy.stdout).enforcement).toBe('not_enforced_stage_2d');

      const layout = await runCli(['config', 'get', 'company.layout'], home);
      expect(layout.exitCode).toBe(0);
      expect(JSON.parse(layout.stdout).templates.action.frontmatter.type).toBe('action');

      const current = await runCli(['sources', 'current', '--json'], home);
      expect(current.exitCode).toBe(0);
      const currentParsed = JSON.parse(current.stdout);
      expect(currentParsed.source_id).toBe('company');
      expect(currentParsed.tier).toBe('brain_default');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);

  test('does not combine company mode with thin-client or migrate-only init', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-init-company-flags-'));
    try {
      const mcpOnly = await runCli(['init', '--company', '--mcp-only', '--json'], home);
      expect(mcpOnly.exitCode).toBe(1);
      expect(lastJsonLine(mcpOnly.stdout).reason).toBe('company_mcp_only_unsupported');

      const migrateOnly = await runCli(['init', '--company', '--migrate-only', '--json'], home);
      expect(migrateOnly.exitCode).toBe(1);
      expect(lastJsonLine(migrateOnly.stdout).reason).toBe('company_migrate_only_unsupported');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
