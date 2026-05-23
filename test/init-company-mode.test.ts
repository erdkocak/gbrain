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
      expect(parsed.company.hosted_skill_exposure).toBe('not_enabled');
      expect(parsed.company.metadata_placeholders.visibility_policy_id).toBeNull();

      const cfg = JSON.parse(readFileSync(join(home, '.gbrain', 'config.json'), 'utf-8'));
      expect(cfg.company.mode).toBe('trusted_workspace');
      expect(cfg.company.primary_source_id).toBe('company');
      expect(cfg.company.policy_enforcement).toBe('deferred');
      expect(cfg.company.security_claim).toBe('none_trusted_workspace_only');

      const mode = await runCli(['config', 'get', 'company.mode'], home);
      expect(mode.exitCode).toBe(0);
      expect(mode.stdout.trim()).toBe('trusted_workspace');

      const defaultSource = await runCli(['config', 'get', 'sources.default'], home);
      expect(defaultSource.exitCode).toBe(0);
      expect(defaultSource.stdout.trim()).toBe('company');

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
