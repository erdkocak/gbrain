import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AuthInfo } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { applyCompanyModeSkeleton } from '../src/core/company-mode.ts';
import { applyCompanyLayout } from '../src/core/company-layout.ts';
import { applyCompanyPolicySeed, parseCompanyPolicySeedYaml } from '../src/core/company-policy.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { dispatchToolCall, type ToolResult } from '../src/mcp/dispatch.ts';
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
  - id: company-sales-user
    email: sales@example.invalid
    idp_subjects:
      - oauth-client:gbrain_cl_sales
      - client-name:sales-agent
  - id: company-mixed-user
    email: mixed@example.invalid
    idp_subjects:
      - oauth-client:gbrain_cl_mixed
      - client-name:mixed-agent
groups:
  - id: engineering
    members:
      - company-eng-user
      - company-mixed-user
  - id: sales
    members:
      - company-sales-user
      - company-mixed-user
policies:
  - id: company-trusted-workspace
    read:
      groups:
        - engineering
        - sales
    write:
      groups:
        - engineering
        - sales
  - id: engineering-notes
    read:
      groups:
        - engineering
    write:
      groups:
        - engineering
  - id: sales-notes
    read:
      groups:
        - sales
    write:
      groups:
        - sales
path_defaults:
  - object_type: doc
    path_prefix: docs/engineering/
    visibility_policy_id: engineering-notes
  - object_type: doc
    path_prefix: docs/sales/
    visibility_policy_id: sales-notes
  - object_type: decision
    path_prefix: decisions/
    visibility_policy_id: engineering-notes
audit:
  readers:
    groups:
      - engineering
      - sales
`);
}

async function initCompanyBrain(): Promise<void> {
  await applyCompanyModeSkeleton(engine);
  await applyCompanyLayout(engine);
  await applyCompanyPolicySeed(engine, companySeed());
}

function hostedAuth(client: 'eng' | 'sales' | 'mixed'): AuthInfo {
  return {
    token: `gbrain_at_${client}`,
    clientId: `gbrain_cl_${client}`,
    clientName: `${client}-agent`,
    scopes: ['read', 'write'],
    sourceId: 'company',
    allowedSources: ['company'],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

async function callAs(client: 'eng' | 'sales' | 'mixed', name: string, params: Record<string, unknown> = {}) {
  return dispatchToolCall(engine, name, params, {
    remote: true,
    sourceId: 'company',
    auth: hostedAuth(client),
  });
}

function parseToolJson(result: ToolResult): any {
  return JSON.parse(result.content[0]!.text);
}

function markdown(type: string, title: string, frontmatter: Record<string, unknown> = {}, body = 'Body'): string {
  return serializeMarkdown(frontmatter, body, '', { type, title, tags: [] });
}

async function seedPage(slug: string, policyId: string): Promise<void> {
  await engine.putPage(slug, {
    type: 'doc',
    title: slug,
    compiled_truth: `${slug} body`,
    timeline: '',
    frontmatter: {
      visibility_policy_id: policyId,
      visibility_policy_ids: [policyId],
      policy_enforcement: 'enforced',
    },
  }, { sourceId: 'company' });
}

describe('company write authorization', () => {
  test('allows hosted page writes to writable path-default policies and stores policy metadata', async () => {
    const result = await callAs('eng', 'put_page', {
      slug: 'docs/engineering/roadmap',
      content: markdown('doc', 'Engineering Roadmap', {}, 'Engineering roadmap body'),
    });

    expect(result.isError).toBeUndefined();
    const response = parseToolJson(result);
    expect(response.status).toBe('created_or_updated');
    expect(response.write_through).toEqual({ written: false, skipped: 'hosted_company_policy' });
    expect(response.facts_backstop).toEqual({ skipped: 'hosted_company_policy' });
    expect(response.writer_lint).toEqual({ skipped: 'hosted_company_policy' });

    const page = await engine.getPage('docs/engineering/roadmap', { sourceId: 'company' });
    expect(page?.frontmatter).toMatchObject({
      visibility_policy_id: 'engineering-notes',
      visibility_policy_ids: ['engineering-notes'],
      created_by: 'company-eng-user',
      hosted_company_write: true,
      local_admin_write: false,
      policy_enforcement: 'enforced',
      object_policy_metadata_kind: 'company_object_policy_metadata',
      object_policy_enforcement: 'enforced',
      visibility_assignment: 'path_default',
      company_policy_user_id: 'company-eng-user',
    });
    expect(typeof page?.frontmatter.company_policy_decision_id).toBe('string');
    expect(typeof page?.frontmatter.company_policy_version).toBe('string');
    expect(typeof page?.frontmatter.company_policy_hash).toBe('string');
  });

  test('denies hosted page writes to non-writable policies', async () => {
    const result = await callAs('eng', 'put_page', {
      slug: 'docs/sales/plan',
      content: markdown('doc', 'Sales Plan', {}, 'Sales plan body'),
    });

    expect(result.isError).toBe(true);
    expect(parseToolJson(result)).toMatchObject({
      error: 'permission_denied',
      message: 'Company write target is not permitted.',
    });
    expect(await engine.getPage('docs/sales/plan', { sourceId: 'company' })).toBeNull();
  });

  test('requires write access to an existing page policy before overwrite or reclassification', async () => {
    await seedPage('docs/sales/existing', 'sales-notes');

    const deniedOverwrite = await callAs('eng', 'put_page', {
      slug: 'docs/sales/existing',
      content: markdown('doc', 'Existing Sales', {
        visibility_policy_id: 'engineering-notes',
      }, 'Unauthorized rewrite'),
    });
    expect(deniedOverwrite.isError).toBe(true);
    expect(parseToolJson(deniedOverwrite)).toMatchObject({
      error: 'permission_denied',
      message: 'Company write target is not permitted.',
    });
    expect((await engine.getPage('docs/sales/existing', { sourceId: 'company' }))?.compiled_truth)
      .toBe('docs/sales/existing body');

    await seedPage('docs/engineering/existing', 'engineering-notes');
    const samePolicyUpdate = await callAs('eng', 'put_page', {
      slug: 'docs/engineering/existing',
      content: markdown('doc', 'Existing Engineering', {}, 'Authorized rewrite'),
    });
    expect(samePolicyUpdate.isError).toBeUndefined();
    expect((await engine.getPage('docs/engineering/existing', { sourceId: 'company' }))?.compiled_truth)
      .toBe('Authorized rewrite');

    const allowedReclassification = await callAs('mixed', 'put_page', {
      slug: 'docs/sales/existing',
      content: markdown('doc', 'Existing Sales', {
        visibility_policy_id: 'engineering-notes',
      }, 'Authorized reclassification'),
    });
    expect(allowedReclassification.isError).toBeUndefined();
    const reclassified = await engine.getPage('docs/sales/existing', { sourceId: 'company' });
    expect(reclassified?.compiled_truth).toBe('Authorized reclassification');
    expect(reclassified?.frontmatter.visibility_policy_ids).toEqual(['engineering-notes']);
  });

  test('inherits derived visibility from one readable input', async () => {
    await seedPage('docs/engineering/source', 'engineering-notes');

    const result = await callAs('eng', 'put_page', {
      slug: 'decisions/derived-eng',
      content: markdown('decision', 'Derived Engineering Decision', {
        derived_from: ['docs/engineering/source'],
      }, 'Derived decision body'),
    });

    expect(result.isError).toBeUndefined();
    const page = await engine.getPage('decisions/derived-eng', { sourceId: 'company' });
    expect(page?.frontmatter).toMatchObject({
      visibility_policy_id: 'engineering-notes',
      visibility_policy_ids: ['engineering-notes'],
      derived_from: ['docs/engineering/source'],
      visibility_assignment: 'derived_visibility',
      visibility_assignment_reason: 'single_input_inherits',
    });
  });

  test('rejects derived writes with empty policy intersections', async () => {
    await seedPage('docs/engineering/source', 'engineering-notes');
    await seedPage('docs/sales/source', 'sales-notes');

    const result = await callAs('mixed', 'put_page', {
      slug: 'decisions/mixed-empty-intersection',
      content: markdown('decision', 'Mixed Derived Decision', {
        derived_from: ['docs/engineering/source', 'docs/sales/source'],
      }, 'Mixed derived body'),
    });

    expect(result.isError).toBe(true);
    expect(parseToolJson(result)).toMatchObject({
      error: 'permission_denied',
      message: 'Company write target is not permitted.',
    });
    expect(await engine.getPage('decisions/mixed-empty-intersection', { sourceId: 'company' })).toBeNull();
  });

  test('requires explicit writable target policy for no-input derivations', async () => {
    const missingTarget = await callAs('eng', 'put_page', {
      slug: 'decisions/no-input-derived',
      content: markdown('decision', 'No Input Derived', {
        derived_from: [],
      }, 'No input body'),
    });
    expect(missingTarget.isError).toBe(true);
    expect(parseToolJson(missingTarget).error).toBe('permission_denied');

    const explicitTarget = await callAs('eng', 'put_page', {
      slug: 'decisions/no-input-derived',
      content: markdown('decision', 'No Input Derived', {
        derived_from: [],
        visibility_policy_id: 'engineering-notes',
      }, 'No input body'),
    });
    expect(explicitTarget.isError).toBeUndefined();

    const page = await engine.getPage('decisions/no-input-derived', { sourceId: 'company' });
    expect(page?.frontmatter).toMatchObject({
      visibility_policy_id: 'engineering-notes',
      visibility_policy_ids: ['engineering-notes'],
      derived_from: [],
      visibility_assignment: 'preserved_existing',
      visibility_assignment_reason: 'explicit_target_policy',
    });
  });

  test('keeps unreviewed hosted mutating tools disabled', async () => {
    await seedPage('docs/engineering/source', 'engineering-notes');

    const timeline = await callAs('eng', 'add_timeline_entry', {
      slug: 'docs/engineering/source',
      date: '2026-01-01',
      summary: 'Hidden write',
      detail: 'Should be denied',
    });
    expect(timeline.isError).toBe(true);
    expect(parseToolJson(timeline)).toMatchObject({
      error: 'permission_denied',
      message: 'Hosted company write access is not enabled for this tool.',
    });

    const facts = await callAs('eng', 'extract_facts', {
      turn_text: 'The team committed to ship a prototype.',
    });
    expect(facts.isError).toBe(true);
    expect(parseToolJson(facts)).toMatchObject({
      error: 'permission_denied',
      message: 'Hosted company write access is not enabled for this tool.',
    });

    const upload = await callAs('eng', 'file_upload', {
      path: '/tmp/does-not-exist.txt',
      page_slug: 'docs/engineering/source',
    });
    expect(upload.isError).toBe(true);
    expect(parseToolJson(upload).error).toBe('permission_denied');

    const jobControls: Array<[string, Record<string, unknown>]> = [
      ['pause_job', { id: 1 }],
      ['resume_job', { id: 1 }],
      ['replay_job', { id: 1 }],
      ['send_job_message', { id: 1, payload: { text: 'blocked' } }],
    ];
    for (const [name, params] of jobControls) {
      const result = await callAs('eng', name, params);
      expect(result.isError).toBe(true);
      expect(parseToolJson(result)).toMatchObject({
        error: 'permission_denied',
        message: 'Hosted company write access is not enabled for this tool.',
      });
    }
  });

  test('leaves trusted local writes on the local/admin path', async () => {
    const result = await dispatchToolCall(engine, 'put_page', {
      slug: 'docs/sales/local-admin',
      content: markdown('doc', 'Local Admin', {}, 'Local body'),
    }, {
      remote: false,
      sourceId: 'company',
    });

    expect(result.isError).toBeUndefined();
    const page = await engine.getPage('docs/sales/local-admin', { sourceId: 'company' });
    expect(page?.frontmatter.visibility_policy_id).toBeUndefined();
    expect(page?.frontmatter.hosted_company_write).toBeUndefined();
    expect(page?.frontmatter.local_admin_write).toBeUndefined();
  });
});
