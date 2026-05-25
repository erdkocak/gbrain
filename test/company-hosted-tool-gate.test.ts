import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { operationsByName, type AuthInfo } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { applyCompanyModeSkeleton } from '../src/core/company-mode.ts';
import { applyCompanyLayout } from '../src/core/company-layout.ts';
import { applyCompanyPolicySeed, parseCompanyPolicySeedYaml } from '../src/core/company-policy.ts';
import {
  classifyCompanyHostedSkill,
  classifyCompanyHostedTool,
} from '../src/core/company-hosted-surface.ts';
import { COMPANY_HOSTED_TOOL_GATE_DENIAL } from '../src/core/company-hosted-tool-gate.ts';
import { dispatchToolCall, listVisibleOperationsForDispatch, type ToolResult } from '../src/mcp/dispatch.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await initCompanyBrain();
});

function companySeed() {
  return parseCompanyPolicySeedYaml(`
version: 1
users:
  - id: company-eng-user
    email: eng@example.invalid
    idp_subjects:
      - oauth-client:gbrain_cl_eng
      - client-name:eng-agent
groups:
  - id: engineering
    members:
      - company-eng-user
policies:
  - id: company-trusted-workspace
    read:
      groups:
        - engineering
    write:
      groups:
        - engineering
  - id: engineering-notes
    read:
      groups:
        - engineering
    write:
      groups:
        - engineering
path_defaults:
  - object_type: doc
    path_prefix: docs/engineering/
    visibility_policy_id: engineering-notes
audit:
  readers:
    groups:
      - engineering
`);
}

async function initCompanyBrain(): Promise<void> {
  await applyCompanyModeSkeleton(engine);
  await applyCompanyLayout(engine);
  await applyCompanyPolicySeed(engine, companySeed());
}

function hostedAuth(overrides: Partial<AuthInfo> = {}): AuthInfo {
  return {
    token: 'gbrain_at_eng',
    clientId: 'gbrain_cl_eng',
    clientName: 'eng-agent',
    scopes: ['read', 'write'],
    sourceId: 'company',
    allowedSources: ['company'],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

async function callAs(name: string, params: Record<string, unknown> = {}) {
  return dispatchToolCall(engine, name, params, {
    remote: true,
    sourceId: 'company',
    auth: hostedAuth(),
  });
}

function parseToolJson(result: ToolResult): any {
  return JSON.parse(result.content[0]!.text);
}

describe('hosted company tool gate', () => {
  test('advertises only reviewed hosted company tools for resolved company callers', async () => {
    const visible = await listVisibleOperationsForDispatch(engine, {
      remote: true,
      sourceId: 'company',
      auth: hostedAuth(),
    });
    const names = visible.map((op) => op.name).sort();

    expect(names).toContain('query');
    expect(names).toContain('search');
    expect(names).toContain('get_page');
    expect(names).toContain('list_pages');
    expect(names).toContain('get_timeline');
    expect(names).toContain('put_page');
    expect(names).toContain('whoami');
    expect(names).toContain('get_chunks');
    expect(names).toContain('get_ingest_log');
    expect(names).toContain('recall');
    expect(names).toContain('traverse_graph');
    expect(names).toContain('code_def');

    expect(names).not.toContain('file_url');
    expect(names).not.toContain('file_upload');
    expect(names).not.toContain('get_health');
    expect(names).not.toContain('submit_job');
    expect(names).not.toContain('submit_agent');
    expect(names).not.toContain('find_anomalies');
    expect(names).not.toContain('takes_scorecard');
    expect(names).not.toContain('search_by_image');
  });

  test('returns no advertised tools when company identity cannot resolve', async () => {
    const visible = await listVisibleOperationsForDispatch(engine, {
      remote: true,
      sourceId: 'company',
      auth: hostedAuth({ clientId: 'gbrain_cl_unknown', clientName: 'unknown-agent' }),
    });

    expect(visible).toEqual([]);
  });

  test('denies unreviewed hosted company tools even when they are read-only', async () => {
    for (const [name, params] of [
      ['get_health', {}],
      ['find_anomalies', {}],
      ['takes_scorecard', {}],
      ['search_by_image', { query: 'diagram' }],
    ] as const) {
      const result = await callAs(name, params);
      expect(result.isError).toBe(true);
      expect(parseToolJson(result)).toMatchObject({
        error: 'permission_denied',
        message: COMPANY_HOSTED_TOOL_GATE_DENIAL,
      });
    }
  });

  test('keeps subagent and external execution surfaces disabled', async () => {
    const agent = await callAs('submit_agent', { prompt: 'Run a follow-up agent.' });
    expect(agent.isError).toBe(true);
    expect(parseToolJson(agent)).toMatchObject({
      error: 'permission_denied',
      message: 'Hosted company write access is not enabled for this tool.',
    });

    const job = await callAs('submit_job', { name: 'sync', data: {} });
    expect(job.isError).toBe(true);
    expect(parseToolJson(job)).toMatchObject({
      error: 'permission_denied',
      message: 'Hosted company write access is not enabled for this tool.',
    });
  });

  test('keeps job operation metadata precise for read and control surfaces', () => {
    expect(operationsByName.get_job.mutating).toBeUndefined();
    expect(operationsByName.get_job_progress.mutating).toBeUndefined();
    expect(operationsByName.pause_job.mutating).toBe(true);
    expect(operationsByName.resume_job.mutating).toBe(true);
  });

  test('keeps the filing classifier advisory-only and denies unclassified skills', () => {
    expect(classifyCompanyHostedSkill('briefing').decision).toBe('allow');

    const taxonomist = classifyCompanyHostedSkill('brain-taxonomist');
    expect(taxonomist.decision).toBe('allow_advisory');
    expect(taxonomist.advisory_only).toBe(true);

    const putPage = classifyCompanyHostedTool('put_page');
    expect(putPage.decision).toBe('allow');
    expect(putPage.source).toBe('reviewed_direct');
    expect(putPage.skills).not.toContain('brain-taxonomist');

    expect(classifyCompanyHostedSkill('publish').decision).toBe('deny');
    expect(classifyCompanyHostedTool('submit_agent').decision).toBe('deny');
  });
});
