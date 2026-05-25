import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AuthInfo } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { applyCompanyModeSkeleton } from '../src/core/company-mode.ts';
import { applyCompanyLayout } from '../src/core/company-layout.ts';
import { applyCompanyPolicySeed, parseCompanyPolicySeedYaml } from '../src/core/company-policy.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import {
  configureGateway,
  resetGateway,
  __setEmbedTransportForTests,
} from '../src/core/ai/gateway.ts';
import { dispatchToolCall, listVisibleOperationsForDispatch, type ToolResult } from '../src/mcp/dispatch.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

const ENG_POLICY = 'engineering-notes';
const SALES_POLICY = 'sales-notes';
const COMPANY_ENG = 'docs/engineering/matrix-visible';
const COMPANY_ENG_PEER = 'docs/engineering/matrix-peer';
const COMPANY_SALES = 'docs/sales/matrix-secret';
const COMPANY_UNLABELED = 'docs/engineering/matrix-unlabeled';
const SHARED_ENG = 'docs/shared/matrix-shared';
const QUERY = 'matrix permission regression marker';
const DIMS = 1536;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

beforeEach(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await resetPgliteState(engine);
  await initCompanyBrain();
  await seedMatrixRows();
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
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config)
     VALUES ('shared', 'shared', '{}'::jsonb)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
  );
  await engine.setConfig('search.cache.enabled', 'true');
  await engine.setConfig('search.reranker.enabled', 'false');
  await engine.executeRaw('DELETE FROM query_cache');
  await engine.executeRaw('DELETE FROM code_traversal_cache');
}

function hostedAuth(
  client: 'eng' | 'sales' | 'mixed',
  allowedSources: string[] = ['company'],
): AuthInfo {
  return {
    token: `gbrain_at_${client}`,
    clientId: `gbrain_cl_${client}`,
    clientName: `${client}-agent`,
    scopes: ['read', 'write'],
    sourceId: allowedSources[0] ?? 'company',
    allowedSources,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

async function callAs(
  client: 'eng' | 'sales' | 'mixed',
  name: string,
  params: Record<string, unknown> = {},
  opts: { sourceId?: string; allowedSources?: string[] } = {},
) {
  return dispatchToolCall(engine, name, params, {
    remote: true,
    sourceId: opts.sourceId ?? 'company',
    auth: hostedAuth(client, opts.allowedSources ?? ['company']),
  });
}

function parseToolJson<T = any>(result: ToolResult): T {
  return JSON.parse(result.content[0]!.text) as T;
}

function markdown(type: string, title: string, frontmatter: Record<string, unknown> = {}, body = 'Body'): string {
  return serializeMarkdown(frontmatter, body, '', { type, title, tags: [] });
}

function embedding(seed: number): Float32Array {
  const out = new Float32Array(DIMS);
  out[seed % DIMS] = 1;
  out[(seed + 1) % DIMS] = 0.25;
  return out;
}

function stubEmbeddings(): void {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: DIMS,
    env: { OPENAI_API_KEY: 'sk-test' },
  });
  __setEmbedTransportForTests(async (args: any) => ({
    embeddings: args.values.map(() => Array.from(embedding(7))),
  }) as any);
}

async function seedMatrixRows(): Promise<void> {
  const visible = await seedTextPage(
    COMPANY_ENG,
    ENG_POLICY,
    'company',
    `${QUERY} visible engineering body`,
  );
  await seedTextPage(
    COMPANY_ENG_PEER,
    ENG_POLICY,
    'company',
    `${QUERY} visible engineering peer`,
  );
  const secret = await seedTextPage(
    COMPANY_SALES,
    SALES_POLICY,
    'company',
    `${QUERY} secret sales body`,
  );
  await seedTextPage(
    SHARED_ENG,
    ENG_POLICY,
    'shared',
    `${QUERY} shared source engineering body`,
  );
  await engine.putPage(COMPANY_UNLABELED, {
    type: 'doc',
    title: COMPANY_UNLABELED,
    compiled_truth: `${QUERY} unlabeled legacy body`,
    timeline: '',
    frontmatter: {},
  }, { sourceId: 'company' });
  await engine.upsertChunks(COMPANY_UNLABELED, [{
    chunk_index: 0,
    chunk_text: `${QUERY} unlabeled legacy body`,
    chunk_source: 'compiled_truth',
    embedding: embedding(7),
    modality: 'text',
  }], { sourceId: 'company' });

  await engine.addTakesBatch([
    {
      page_id: visible.id,
      row_num: 1,
      claim: 'visible engineering take',
      kind: 'take',
      holder: 'world',
      weight: 0.7,
      source: 'fixture',
    },
    {
      page_id: secret.id,
      row_num: 1,
      claim: 'secret sales take',
      kind: 'take',
      holder: 'world',
      weight: 0.7,
      source: 'fixture',
    },
  ]);

  await engine.insertFacts([
    {
      row_num: 1,
      source_markdown_slug: COMPANY_ENG,
      entity_slug: COMPANY_ENG,
      fact: 'visible engineering fact',
      kind: 'fact',
      visibility: 'world',
      notability: 'medium',
      source: 'fixture',
      confidence: 1,
      valid_from: new Date('2026-01-01T00:00:00Z'),
    },
    {
      row_num: 1,
      source_markdown_slug: COMPANY_SALES,
      entity_slug: COMPANY_SALES,
      fact: 'secret sales fact',
      kind: 'fact',
      visibility: 'world',
      notability: 'medium',
      source: 'fixture',
      confidence: 1,
      valid_from: new Date('2026-01-01T00:00:00Z'),
    },
  ], { source_id: 'company' });

  await engine.addLink(COMPANY_ENG, COMPANY_ENG_PEER, 'visible graph edge', 'mentions', undefined, undefined, undefined, {
    fromSourceId: 'company',
    toSourceId: 'company',
  });
  await engine.addLink(COMPANY_ENG, COMPANY_SALES, 'hidden sales graph edge', 'mentions', undefined, undefined, undefined, {
    fromSourceId: 'company',
    toSourceId: 'company',
  });
  await engine.addLink(COMPANY_SALES, COMPANY_ENG, 'hidden sales backlink', 'mentions', undefined, undefined, undefined, {
    fromSourceId: 'company',
    toSourceId: 'company',
  });

  const start = await seedCodePage('code/engineering-start', ENG_POLICY, 'visibleStart');
  const target = await seedCodePage('code/engineering-target', ENG_POLICY, 'visibleTarget');
  const hidden = await seedCodePage('code/sales-hidden-target', SALES_POLICY, 'hiddenTarget');
  await engine.addCodeEdges([
    {
      from_chunk_id: start,
      to_chunk_id: target,
      from_symbol_qualified: 'visibleStart',
      to_symbol_qualified: 'visibleTarget',
      edge_type: 'calls',
      source_id: 'company',
    },
    {
      from_chunk_id: start,
      to_chunk_id: hidden,
      from_symbol_qualified: 'visibleStart',
      to_symbol_qualified: 'hiddenTarget',
      edge_type: 'calls',
      source_id: 'company',
    },
  ]);
}

async function seedTextPage(
  slug: string,
  policyId: string,
  sourceId: string,
  text: string,
) {
  const page = await engine.putPage(slug, {
    type: 'doc',
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
    embedding: embedding(7),
    modality: 'text',
  }], { sourceId });
  return page;
}

async function seedCodePage(slug: string, policyId: string, symbol: string): Promise<number> {
  const text = `export function ${symbol}() { return "${symbol}"; }`;
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
  }, { sourceId: 'company' });
  await engine.upsertChunks(slug, [{
    chunk_index: 0,
    chunk_text: text,
    chunk_source: 'compiled_truth',
    language: 'typescript',
    symbol_name: symbol,
    symbol_name_qualified: symbol,
    symbol_type: 'function',
  }], { sourceId: 'company' });
  const chunks = await engine.getChunks(slug, { sourceId: 'company' });
  return chunks[0]!.id;
}

async function cacheRows(): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM query_cache`,
  );
  return rows[0]?.n ?? 0;
}

function textOf(value: unknown): string {
  return JSON.stringify(value);
}

describe('company permission regression matrix', () => {
  test('applies user policy and source scope to direct reads, facts, takes, and tool listing', async () => {
    const visible = parseToolJson<{ compiled_truth: string }>(
      await callAs('eng', 'get_page', { slug: COMPANY_ENG }),
    );
    expect(visible.compiled_truth).toContain('visible engineering body');

    const hidden = await callAs('eng', 'get_page', { slug: COMPANY_SALES });
    expect(hidden.isError).toBe(true);
    expect(parseToolJson(hidden)).toMatchObject({ error: 'page_not_found' });
    expect(textOf(hidden)).not.toContain('secret sales body');

    const unlabeled = await callAs('eng', 'get_page', { slug: COMPANY_UNLABELED });
    expect(unlabeled.isError).toBe(true);
    expect(parseToolJson(unlabeled)).toMatchObject({ error: 'page_not_found' });
    expect(textOf(unlabeled)).not.toContain('unlabeled legacy body');

    const shared = parseToolJson<{ compiled_truth: string }>(
      await callAs('eng', 'get_page', { slug: SHARED_ENG }, {
        sourceId: 'shared',
        allowedSources: ['company', 'shared'],
      }),
    );
    expect(shared.compiled_truth).toContain('shared source engineering body');

    const sourceOverride = await callAs('eng', 'query', {
      query: QUERY,
      source_id: 'shared',
      limit: 10,
      expand: false,
    }, { allowedSources: ['company'] });
    expect(sourceOverride.isError).toBe(true);
    expect(parseToolJson(sourceOverride)).toMatchObject({ error: 'permission_denied' });

    const allSources = await callAs('eng', 'query', {
      query: QUERY,
      source_id: '__all__',
      limit: 10,
    }, { allowedSources: ['company', 'shared'] });
    expect(allSources.isError).toBe(true);
    expect(parseToolJson(allSources)).toMatchObject({ error: 'permission_denied' });

    const salesPages = parseToolJson<Array<{ slug: string }>>(await callAs('sales', 'list_pages'));
    expect(salesPages.map((row) => row.slug)).toContain(COMPANY_SALES);
    expect(salesPages.map((row) => row.slug)).not.toContain(COMPANY_ENG);

    const recall = parseToolJson<{ facts: Array<{ fact: string }> }>(await callAs('eng', 'recall'));
    expect(recall.facts.map((row) => row.fact)).toEqual(['visible engineering fact']);

    const takes = parseToolJson<Array<{ claim: string }>>(await callAs('eng', 'takes_list'));
    expect(takes.map((row) => row.claim)).toEqual(['visible engineering take']);

    const visibleTools = await listVisibleOperationsForDispatch(engine, {
      remote: true,
      sourceId: 'company',
      auth: hostedAuth('eng'),
    });
    const toolNames = visibleTools.map((op) => op.name);
    expect(toolNames).toContain('query');
    expect(toolNames).toContain('put_page');
    expect(toolNames).not.toContain('takes_scorecard');
    expect(toolNames).not.toContain('find_anomalies');
    expect(await listVisibleOperationsForDispatch(engine, {
      remote: true,
      sourceId: 'company',
      auth: { ...hostedAuth('eng'), clientId: 'gbrain_cl_unknown', clientName: 'unknown-agent' },
    })).toEqual([]);
  });

  test('filters retrieval before rerank, keeps cache disabled, and enforces graph/code traversal', async () => {
    stubEmbeddings();

    const firstQuery = parseToolJson<Array<{ slug: string }>>(await callAs('eng', 'query', {
      query: QUERY,
      limit: 10,
      expand: false,
      use_cache: true,
    }));
    expect(firstQuery.map((row) => row.slug)).toContain(COMPANY_ENG);
    expect(firstQuery.map((row) => row.slug)).not.toContain(COMPANY_SALES);
    expect(textOf(firstQuery)).not.toContain('secret sales body');

    await callAs('eng', 'query', {
      query: QUERY,
      limit: 10,
      expand: false,
      use_cache: true,
    });
    expect(await cacheRows()).toBe(0);

    let rerankerDocuments: string[] = [];
    const reranked = await hybridSearch(engine, QUERY, {
      sourceId: 'company',
      readablePolicyIds: [ENG_POLICY],
      limit: 10,
      reranker: {
        enabled: true,
        topNIn: 30,
        topNOut: null,
        rerankerFn: async (input) => {
          rerankerDocuments = input.documents;
          return input.documents.map((_, index) => ({ index, relevanceScore: 1 - index * 0.01 }));
        },
      },
    });
    expect(reranked.map((row) => row.slug)).toContain(COMPANY_ENG);
    expect(reranked.map((row) => row.slug)).not.toContain(COMPANY_SALES);
    expect(rerankerDocuments.join('\n')).toContain('visible engineering body');
    expect(rerankerDocuments.join('\n')).not.toContain('secret sales body');

    const links = parseToolJson<Array<{ to_slug: string; context: string }>>(
      await callAs('eng', 'get_links', { slug: COMPANY_ENG }),
    );
    expect(links.map((link) => link.to_slug)).toEqual([COMPANY_ENG_PEER]);
    expect(textOf(links)).not.toContain('hidden sales graph edge');

    const graph = parseToolJson<Array<{ slug: string }>>(
      await callAs('eng', 'traverse_graph', { slug: COMPANY_ENG, depth: 2 }),
    );
    expect(new Set(graph.map((node) => node.slug))).toEqual(new Set([COMPANY_ENG, COMPANY_ENG_PEER]));
    expect(textOf(graph)).not.toContain(COMPANY_SALES);

    const flow = parseToolJson(await callAs('eng', 'code_flow', {
      entry_point: 'visibleStart',
      exact: true,
      depth: 1,
    }));
    expect(textOf(flow)).toContain('visibleTarget');
    expect(textOf(flow)).not.toContain('hiddenTarget');
  });

  test('authorizes the reviewed write path and denies incompatible derived outputs', async () => {
    const engWrite = await callAs('eng', 'put_page', {
      slug: 'docs/engineering/write-ok',
      content: markdown('doc', 'Write OK', {}, 'Engineering write body'),
    });
    expect(engWrite.isError).toBeUndefined();

    const salesWrite = await callAs('eng', 'put_page', {
      slug: 'docs/sales/write-denied',
      content: markdown('doc', 'Write Denied', {}, 'Sales write body'),
    });
    expect(salesWrite.isError).toBe(true);
    expect(parseToolJson(salesWrite)).toMatchObject({ error: 'permission_denied' });

    const engMultiPolicy = await callAs('eng', 'put_page', {
      slug: 'docs/engineering/multi-policy-denied',
      content: markdown('doc', 'Multi Policy', {
        visibility_policy_ids: [ENG_POLICY, SALES_POLICY],
      }, 'Multi-policy body'),
    });
    expect(engMultiPolicy.isError).toBe(true);

    const mixedMultiPolicy = await callAs('mixed', 'put_page', {
      slug: 'docs/engineering/multi-policy-ok',
      content: markdown('doc', 'Multi Policy OK', {
        visibility_policy_ids: [ENG_POLICY, SALES_POLICY],
      }, 'Mixed user can write both policies'),
    });
    expect(mixedMultiPolicy.isError).toBeUndefined();
    const mixedPage = await engine.getPage('docs/engineering/multi-policy-ok', { sourceId: 'company' });
    expect(mixedPage?.frontmatter.visibility_policy_ids).toEqual([ENG_POLICY, SALES_POLICY]);

    const derivedOk = await callAs('eng', 'put_page', {
      slug: 'decisions/engineering-derived-ok',
      content: markdown('decision', 'Engineering Derived OK', {
        derived_from: [COMPANY_ENG, COMPANY_ENG_PEER],
      }, 'Derived engineering body'),
    });
    expect(derivedOk.isError).toBeUndefined();
    const derived = await engine.getPage('decisions/engineering-derived-ok', { sourceId: 'company' });
    expect(derived?.frontmatter.visibility_policy_ids).toEqual([ENG_POLICY]);

    const emptyIntersection = await callAs('mixed', 'put_page', {
      slug: 'decisions/mixed-empty-denied',
      content: markdown('decision', 'Mixed Empty Denied', {
        derived_from: [COMPANY_ENG, COMPANY_SALES],
      }, 'Mixed derived body'),
    });
    expect(emptyIntersection.isError).toBe(true);
    expect(parseToolJson(emptyIntersection)).toMatchObject({ error: 'permission_denied' });
    expect(await engine.getPage('decisions/mixed-empty-denied', { sourceId: 'company' })).toBeNull();
  });

  test('denies stale policy metadata, file URLs, analytics, and unreviewed execution surfaces', async () => {
    const unsafeTools: Array<[string, Record<string, unknown>]> = [
      ['get_health', {}],
      ['find_anomalies', {}],
      ['takes_scorecard', {}],
      ['search_by_image', { query: 'diagram' }],
    ];
    for (const [name, params] of unsafeTools) {
      const result = await callAs('eng', name, params);
      expect(result.isError).toBe(true);
      expect(parseToolJson(result)).toMatchObject({ error: 'permission_denied' });
    }

    const fileUrl = await callAs('eng', 'file_url', { storage_path: `${COMPANY_ENG}/deck.pdf` });
    expect(fileUrl.isError).toBe(true);
    expect(parseToolJson(fileUrl)).toMatchObject({ error: 'permission_denied' });

    const job = await callAs('eng', 'submit_job', { name: 'sync', data: {} });
    expect(job.isError).toBe(true);
    expect(parseToolJson(job)).toMatchObject({ error: 'permission_denied' });

    const metadataRaw = await engine.getConfig('company.policy.metadata');
    const metadata = JSON.parse(metadataRaw!);
    metadata.policy_hash = '0'.repeat(64);
    await engine.setConfig('company.policy.metadata', JSON.stringify(metadata));

    const stalePolicy = await callAs('eng', 'whoami');
    expect(stalePolicy.isError).toBe(true);
    expect(parseToolJson(stalePolicy)).toMatchObject({ error: 'permission_denied' });
    expect(await listVisibleOperationsForDispatch(engine, {
      remote: true,
      sourceId: 'company',
      auth: hostedAuth('eng'),
    })).toEqual([]);
  });
});
