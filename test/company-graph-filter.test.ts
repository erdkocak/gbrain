import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AuthInfo } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { applyCompanyModeSkeleton } from '../src/core/company-mode.ts';
import { applyCompanyLayout } from '../src/core/company-layout.ts';
import { applyCompanyPolicySeed, parseCompanyPolicySeedYaml } from '../src/core/company-policy.ts';
import { dispatchToolCall, type ToolResult } from '../src/mcp/dispatch.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

const ENG_POLICY = 'engineering-notes';
const SALES_POLICY = 'sales-notes';
const VISIBLE_A = 'docs/engineering/graph-a';
const VISIBLE_B = 'docs/engineering/graph-b';
const SECRET = 'docs/sales/graph-secret';
const FOREIGN = 'docs/engineering/foreign-source';

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
  await seedGraphRows();
  await seedCodeRows();
  await engine.executeRaw('DELETE FROM code_traversal_cache');
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
groups:
  - id: engineering
    members:
      - company-eng-user
  - id: sales
    members:
      - company-sales-user
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

function hostedAuth(): AuthInfo {
  return {
    token: 'gbrain_at_eng',
    clientId: 'gbrain_cl_eng',
    clientName: 'eng-agent',
    scopes: ['read'],
    sourceId: 'company',
    allowedSources: ['company'],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

async function seedGraphRows(): Promise<void> {
  await seedPage(VISIBLE_A, ENG_POLICY, 'company');
  await seedPage(VISIBLE_B, ENG_POLICY, 'company');
  await seedPage(SECRET, SALES_POLICY, 'company');
  await seedPage(FOREIGN, ENG_POLICY, 'default');

  await engine.addLink(VISIBLE_A, VISIBLE_B, 'visible relationship', 'mentions', undefined, undefined, undefined, {
    fromSourceId: 'company',
    toSourceId: 'company',
  });
  await engine.addLink(VISIBLE_B, VISIBLE_A, 'visible backlink', 'mentions', undefined, undefined, undefined, {
    fromSourceId: 'company',
    toSourceId: 'company',
  });
  await engine.addLink(VISIBLE_A, SECRET, 'hidden outgoing relationship', 'mentions', undefined, undefined, undefined, {
    fromSourceId: 'company',
    toSourceId: 'company',
  });
  await engine.addLink(SECRET, VISIBLE_A, 'hidden incoming relationship', 'mentions', undefined, undefined, undefined, {
    fromSourceId: 'company',
    toSourceId: 'company',
  });
  await engine.addLink(VISIBLE_A, FOREIGN, 'foreign source relationship', 'mentions', undefined, undefined, undefined, {
    fromSourceId: 'company',
    toSourceId: 'default',
  });
}

async function seedPage(slug: string, policyId: string, sourceId: string): Promise<void> {
  await engine.putPage(slug, {
    type: 'doc',
    title: slug,
    compiled_truth: `${slug} body`,
    timeline: '',
    frontmatter: {
      visibility_policy_id: policyId,
      visibility_policy_ids: [policyId],
    },
  }, { sourceId });
}

async function seedCodeRows(): Promise<void> {
  const visibleStart = await seedCodePage('code/engineering-start', ENG_POLICY, 'visibleStart');
  const visibleTarget = await seedCodePage('code/engineering-target', ENG_POLICY, 'visibleTarget');
  const visibleLeakTarget = await seedCodePage('code/engineering-leak-target', ENG_POLICY, 'visibleLeakTarget');
  const visibleCaller = await seedCodePage('code/engineering-caller', ENG_POLICY, 'visibleCaller');
  const hiddenTarget = await seedCodePage('code/sales-hidden-target', SALES_POLICY, 'hiddenTarget');
  const hiddenCaller = await seedCodePage('code/sales-hidden-caller', SALES_POLICY, 'hiddenCaller');
  const hiddenDuplicateStart = await seedCodePage('code/sales-duplicate-start', SALES_POLICY, 'visibleStart');
  await seedCodePage('code/shared-source-slug', ENG_POLICY, 'sharedSymbol', {
    text: 'export function sharedSymbol() { return "company visible sharedRefNeedle"; }',
  });
  await seedCodePage('code/shared-source-slug', ENG_POLICY, 'sharedSymbol', {
    sourceId: 'default',
    text: 'export function sharedSymbol() { return "foreign source secret sharedRefNeedle"; }',
  });

  await engine.addCodeEdges([
    {
      from_chunk_id: visibleStart,
      to_chunk_id: visibleTarget,
      from_symbol_qualified: 'visibleStart',
      to_symbol_qualified: 'visibleTarget',
      edge_type: 'calls',
      source_id: 'company',
    },
    {
      from_chunk_id: visibleStart,
      to_chunk_id: hiddenTarget,
      from_symbol_qualified: 'visibleStart',
      to_symbol_qualified: 'hiddenTarget',
      edge_type: 'calls',
      source_id: 'company',
    },
    {
      from_chunk_id: visibleCaller,
      to_chunk_id: visibleStart,
      from_symbol_qualified: 'visibleCaller',
      to_symbol_qualified: 'visibleStart',
      edge_type: 'calls',
      source_id: 'company',
    },
    {
      from_chunk_id: hiddenCaller,
      to_chunk_id: visibleStart,
      from_symbol_qualified: 'hiddenCaller',
      to_symbol_qualified: 'visibleStart',
      edge_type: 'calls',
      source_id: 'company',
    },
    {
      from_chunk_id: hiddenDuplicateStart,
      to_chunk_id: visibleLeakTarget,
      from_symbol_qualified: 'visibleStart',
      to_symbol_qualified: 'visibleLeakTarget',
      edge_type: 'calls',
      source_id: 'company',
    },
  ]);
}

async function seedCodePage(
  slug: string,
  policyId: string,
  symbol: string,
  opts: { sourceId?: string; text?: string } = {},
): Promise<number> {
  const sourceId = opts.sourceId ?? 'company';
  const text = opts.text ?? `export function ${symbol}() { return null; }`;
  await engine.putPage(slug, {
    type: 'code',
    page_kind: 'code',
    title: slug,
    compiled_truth: text,
    timeline: '',
    frontmatter: {
      visibility_policy_id: policyId,
      visibility_policy_ids: [policyId],
    },
  }, { sourceId });
  await engine.upsertChunks(slug, [{
    chunk_index: 0,
    chunk_text: text,
    chunk_source: 'compiled_truth',
    language: 'typescript',
    symbol_name: symbol,
    symbol_name_qualified: symbol,
    symbol_type: 'function',
  }], { sourceId });
  const chunks = await engine.getChunks(slug, { sourceId });
  return chunks[0]!.id;
}

async function callAs(name: string, params: Record<string, unknown> = {}) {
  return dispatchToolCall(engine, name, params, {
    remote: true,
    sourceId: 'company',
    auth: hostedAuth(),
  });
}

function parseToolJson<T = any>(result: ToolResult): T {
  expect(result.isError).not.toBe(true);
  return JSON.parse(result.content[0]!.text) as T;
}

function textOf(value: unknown): string {
  return JSON.stringify(value);
}

async function traversalCacheRows(): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM code_traversal_cache`,
  );
  return rows[0]?.n ?? 0;
}

describe('company graph and code traversal filters', () => {
  test('link reads hide unreadable seeds, unreadable endpoints, and foreign-source endpoints', async () => {
    const links = parseToolJson<Array<{ to_slug: string; context: string }>>(
      await callAs('get_links', { slug: VISIBLE_A }),
    );
    expect(links.map((link) => link.to_slug)).toEqual([VISIBLE_B]);
    expect(textOf(links)).not.toContain(SECRET);
    expect(textOf(links)).not.toContain(FOREIGN);
    expect(textOf(links)).not.toContain('hidden outgoing relationship');

    const hiddenSeedLinks = parseToolJson<unknown[]>(await callAs('get_links', { slug: SECRET }));
    expect(hiddenSeedLinks).toEqual([]);

    const backlinks = parseToolJson<Array<{ from_slug: string; context: string }>>(
      await callAs('get_backlinks', { slug: VISIBLE_A }),
    );
    expect(backlinks.map((link) => link.from_slug)).toEqual([VISIBLE_B]);
    expect(textOf(backlinks)).not.toContain(SECRET);
    expect(textOf(backlinks)).not.toContain('hidden incoming relationship');
  });

  test('graph traversal hides unreadable seeds, frontier nodes, endpoints, and path metadata', async () => {
    const nodes = parseToolJson<Array<{ slug: string; links: Array<{ to_slug: string }> }>>(
      await callAs('traverse_graph', { slug: VISIBLE_A, depth: 2 }),
    );
    expect(new Set(nodes.map((node) => node.slug))).toEqual(new Set([VISIBLE_A, VISIBLE_B]));
    expect(textOf(nodes)).not.toContain(SECRET);
    expect(textOf(nodes)).not.toContain(FOREIGN);

    const paths = parseToolJson<Array<{ from_slug: string; to_slug: string; context: string }>>(
      await callAs('traverse_graph', { slug: VISIBLE_A, depth: 2, direction: 'both' }),
    );
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((path) => [VISIBLE_A, VISIBLE_B].includes(path.from_slug))).toBe(true);
    expect(paths.every((path) => [VISIBLE_A, VISIBLE_B].includes(path.to_slug))).toBe(true);
    expect(textOf(paths)).not.toContain(SECRET);
    expect(textOf(paths)).not.toContain('hidden');

    const hiddenSeed = parseToolJson<unknown[]>(await callAs('traverse_graph', { slug: SECRET, depth: 2 }));
    expect(hiddenSeed).toEqual([]);
  });

  test('graph-derived backlink counts only count readable same-source edges', async () => {
    const counts = await engine.getBacklinkCounts([VISIBLE_A], {
      sourceId: 'company',
      readablePolicyIds: [ENG_POLICY],
    });
    expect(counts.get(VISIBLE_A)).toBe(1);

    const denyCounts = await engine.getBacklinkCounts([VISIBLE_A], {
      sourceId: 'company',
      readablePolicyIds: [],
    });
    expect(denyCounts.get(VISIBLE_A)).toBe(0);
  });

  test('code graph traversal filters hidden code endpoints and bypasses traversal cache', async () => {
    const callers = parseToolJson<{ count: number; callers: Array<{ from_symbol_qualified: string }> }>(
      await callAs('code_callers', { symbol: 'visibleStart' }),
    );
    expect(callers.count).toBe(1);
    expect(callers.callers.map((edge) => edge.from_symbol_qualified)).toEqual(['visibleCaller']);

    const callees = parseToolJson<{ count: number; callees: Array<{ to_symbol_qualified: string }> }>(
      await callAs('code_callees', { symbol: 'visibleStart' }),
    );
    expect(callees.count).toBe(1);
    expect(callees.callees.map((edge) => edge.to_symbol_qualified)).toEqual(['visibleTarget']);

    const blast = parseToolJson(await callAs('code_blast', { symbol: 'visibleStart', exact: true, depth: 2 }));
    expect(textOf(blast)).toContain('visibleCaller');
    expect(textOf(blast)).not.toContain('hiddenCaller');
    expect(await traversalCacheRows()).toBe(0);

    const flow = parseToolJson(await callAs('code_flow', { entry_point: 'visibleStart', exact: true, depth: 2 }));
    expect(textOf(flow)).toContain('visibleTarget');
    expect(textOf(flow)).not.toContain('hiddenTarget');
    expect(textOf(flow)).not.toContain('visibleLeakTarget');
    expect(await traversalCacheRows()).toBe(0);

    const hiddenSeed = parseToolJson<{ result: string }>(
      await callAs('code_flow', { entry_point: 'hiddenTarget', exact: true, depth: 1 }),
    );
    expect(hiddenSeed.result).toBe('not_found');
    expect(await traversalCacheRows()).toBe(0);
  });

  test('code definition and reference reads are source and policy scoped before returning snippets', async () => {
    const defs = parseToolJson<{ count: number; defs: Array<{ source_id: string; snippet: string }> }>(
      await callAs('code_def', { symbol: 'sharedSymbol' }),
    );
    expect(defs.count).toBe(1);
    expect(defs.defs[0]!.source_id).toBe('company');
    expect(textOf(defs)).toContain('company visible sharedRefNeedle');
    expect(textOf(defs)).not.toContain('foreign source secret');

    const refs = parseToolJson<{ count: number; refs: Array<{ source_id: string; snippet: string }> }>(
      await callAs('code_refs', { symbol: 'sharedRefNeedle' }),
    );
    expect(refs.count).toBe(1);
    expect(refs.refs[0]!.source_id).toBe('company');
    expect(textOf(refs)).toContain('company visible sharedRefNeedle');
    expect(textOf(refs)).not.toContain('foreign source secret');
  });
});
