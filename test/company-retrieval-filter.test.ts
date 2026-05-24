import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AuthInfo } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { applyCompanyModeSkeleton } from '../src/core/company-mode.ts';
import { applyCompanyLayout } from '../src/core/company-layout.ts';
import { applyCompanyPolicySeed, parseCompanyPolicySeedYaml } from '../src/core/company-policy.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import { expandAnchors, hydrateChunks } from '../src/core/search/two-pass.ts';
import { dispatchToolCall, type ToolResult } from '../src/mcp/dispatch.ts';
import {
  configureGateway,
  resetGateway,
  __setEmbedTransportForTests,
} from '../src/core/ai/gateway.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

const ENG_POLICY = 'engineering-notes';
const SALES_POLICY = 'sales-notes';
const VISIBLE_SLUG = 'docs/engineering/search-visible';
const SECRET_SLUG = 'docs/sales/search-secret';
const VISIBLE_IMAGE_SLUG = 'images/engineering-visible';
const SECRET_IMAGE_SLUG = 'images/sales-secret';
const SHARED_QUERY = 'shared retrieval policy marker';
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
  await seedRetrievalRows();
  await engine.executeRaw('DELETE FROM eval_candidates');
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
  await engine.setConfig('search.reranker.enabled', 'false');
}

function hostedAuth(client: 'eng' | 'sales' = 'eng'): AuthInfo {
  return {
    token: `gbrain_at_${client}`,
    clientId: `gbrain_cl_${client}`,
    clientName: `${client}-agent`,
    scopes: ['read'],
    sourceId: 'company',
    allowedSources: ['company'],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

function fakeTextEmbedding(seed: number): Float32Array {
  const out = new Float32Array(1536);
  out[seed % 1536] = 1;
  out[(seed + 1) % 1536] = 0.25;
  return out;
}

function fakeImageEmbedding(seed: number): Float32Array {
  const out = new Float32Array(1024);
  out[seed % 1024] = 1;
  out[(seed + 1) % 1024] = 0.25;
  return out;
}

function stubGatewayEmbeddings(): void {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: DIMS,
    env: { OPENAI_API_KEY: 'sk-test' },
  });
  __setEmbedTransportForTests(async (args: any) => ({
    embeddings: args.values.map(() => Array.from(fakeTextEmbedding(7))),
  }) as any);
}

async function seedRetrievalRows(): Promise<void> {
  await seedTextPage(
    VISIBLE_SLUG,
    ENG_POLICY,
    `${SHARED_QUERY} visible engineering candidate`,
    fakeTextEmbedding(7),
  );
  await seedTextPage(
    SECRET_SLUG,
    SALES_POLICY,
    `${SHARED_QUERY} secret sales candidate`,
    fakeTextEmbedding(7),
  );
  await seedImagePage(VISIBLE_IMAGE_SLUG, ENG_POLICY, fakeImageEmbedding(3));
  await seedImagePage(SECRET_IMAGE_SLUG, SALES_POLICY, fakeImageEmbedding(3));

  await seedCodePage('code/engineering-anchor', ENG_POLICY, 'visibleAnchor', 'export function visibleAnchor() { return hiddenTarget(); }');
  await seedCodePage('code/sales-hidden-target', SALES_POLICY, 'hiddenTarget', 'export function hiddenTarget() { return 1; }');
  const anchor = await engine.getChunks('code/engineering-anchor', { sourceId: 'company' });
  const hidden = await engine.getChunks('code/sales-hidden-target', { sourceId: 'company' });
  await engine.addCodeEdges([{
    from_chunk_id: anchor[0]!.id,
    to_chunk_id: hidden[0]!.id,
    from_symbol_qualified: 'visibleAnchor',
    to_symbol_qualified: 'hiddenTarget',
    edge_type: 'calls',
  }]);
}

async function seedTextPage(
  slug: string,
  policyId: string,
  text: string,
  embedding: Float32Array,
): Promise<void> {
  await engine.putPage(slug, {
    type: 'doc',
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
    embedding,
    modality: 'text',
  }], { sourceId: 'company' });
}

async function seedImagePage(slug: string, policyId: string, embedding: Float32Array): Promise<void> {
  await engine.putPage(slug, {
    type: 'image',
    page_kind: 'image',
    title: slug,
    compiled_truth: '',
    timeline: '',
    frontmatter: {
      visibility_policy_id: policyId,
      visibility_policy_ids: [policyId],
    },
  }, { sourceId: 'company' });
  await engine.upsertChunks(slug, [{
    chunk_index: 0,
    chunk_text: `${slug} visual marker`,
    chunk_source: 'image_asset',
    embedding_image: embedding,
    modality: 'image',
  }], { sourceId: 'company' });
}

async function seedCodePage(slug: string, policyId: string, symbol: string, text: string): Promise<void> {
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
    symbol_type: 'function',
    symbol_name_qualified: symbol,
  }], { sourceId: 'company' });
}

async function callAs(name: string, params: Record<string, unknown> = {}) {
  return dispatchToolCall(engine, name, params, {
    remote: true,
    sourceId: 'company',
    auth: hostedAuth('eng'),
  });
}

function parseToolJson(result: ToolResult): any {
  return JSON.parse(result.content[0]!.text);
}

async function waitFor<T>(fn: () => Promise<T | null | undefined>): Promise<T | null | undefined> {
  for (let i = 0; i < 40; i++) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

function parsePgTextArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return [];
  const inner = trimmed.slice(1, -1);
  return inner.length === 0 ? [] : inner.split(',').map((entry) => entry.replace(/^"|"$/g, ''));
}

describe('company retrieval filtering', () => {
  test('engine keyword, vector, and image candidates honor readable policy ids', async () => {
    const keyword = await engine.searchKeyword(SHARED_QUERY, {
      sourceId: 'company',
      readablePolicyIds: [ENG_POLICY],
      limit: 10,
    });
    expect(keyword.map((row) => row.slug)).toContain(VISIBLE_SLUG);
    expect(keyword.map((row) => row.slug)).not.toContain(SECRET_SLUG);
    expect(JSON.stringify(keyword)).not.toContain('secret sales candidate');

    const vector = await engine.searchVector(fakeTextEmbedding(7), {
      sourceId: 'company',
      readablePolicyIds: [ENG_POLICY],
      limit: 10,
    });
    expect(vector.map((row) => row.slug)).toContain(VISIBLE_SLUG);
    expect(vector.map((row) => row.slug)).not.toContain(SECRET_SLUG);

    const image = await engine.searchVector(fakeImageEmbedding(3), {
      sourceId: 'company',
      readablePolicyIds: [ENG_POLICY],
      embeddingColumn: 'embedding_image',
      limit: 10,
    });
    expect(image.map((row) => row.slug)).toContain(VISIBLE_IMAGE_SLUG);
    expect(image.map((row) => row.slug)).not.toContain(SECRET_IMAGE_SLUG);

    const none = await engine.searchKeyword(SHARED_QUERY, {
      sourceId: 'company',
      readablePolicyIds: [],
      limit: 10,
    });
    expect(none).toEqual([]);
  });

  test('hybrid reranker receives only readable candidate text', async () => {
    stubGatewayEmbeddings();
    let rerankerDocuments: string[] = [];

    const results = await hybridSearch(engine, SHARED_QUERY, {
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

    expect(results.map((row) => row.slug)).toContain(VISIBLE_SLUG);
    expect(results.map((row) => row.slug)).not.toContain(SECRET_SLUG);
    expect(rerankerDocuments.join('\n')).toContain('visible engineering candidate');
    expect(rerankerDocuments.join('\n')).not.toContain('secret sales candidate');
  });

  test('two-pass expansion and hydration drop unreadable chunks before ranking can use them', async () => {
    const anchor = await engine.getChunks('code/engineering-anchor', { sourceId: 'company' });
    const hidden = await engine.getChunks('code/sales-hidden-target', { sourceId: 'company' });
    const expanded = await expandAnchors(engine, [{
      slug: 'code/engineering-anchor',
      page_id: 0,
      title: 'code/engineering-anchor',
      type: 'code',
      chunk_text: '',
      chunk_source: 'compiled_truth',
      chunk_id: anchor[0]!.id,
      chunk_index: 0,
      score: 1,
      stale: false,
      source_id: 'company',
    } as never], {
      walkDepth: 1,
      sourceId: 'company',
      readablePolicyIds: [ENG_POLICY],
    });
    expect(expanded.map((row) => row.chunk_id)).toContain(anchor[0]!.id);
    expect(expanded.map((row) => row.chunk_id)).not.toContain(hidden[0]!.id);

    const nearHidden = await expandAnchors(engine, [], {
      nearSymbol: 'hiddenTarget',
      sourceId: 'company',
      readablePolicyIds: [ENG_POLICY],
    });
    expect(nearHidden).toEqual([]);

    const hydrated = await hydrateChunks(engine, [anchor[0]!.id, hidden[0]!.id], {
      sourceId: 'company',
      readablePolicyIds: [ENG_POLICY],
    });
    expect(hydrated.map((row) => row.slug)).toEqual(['code/engineering-anchor']);
  });

  test('hosted search and query filter final results before capture and retrieval writeback', async () => {
    stubGatewayEmbeddings();
    const previousContributorMode = process.env.GBRAIN_CONTRIBUTOR_MODE;
    process.env.GBRAIN_CONTRIBUTOR_MODE = '1';
    try {
      const searchResult = await callAs('search', { query: SHARED_QUERY, limit: 10 });
      expect(searchResult.isError).toBeUndefined();
      const searchRows = parseToolJson(searchResult);
      expect(searchRows.map((row: { slug: string }) => row.slug)).toContain(VISIBLE_SLUG);
      expect(searchRows.map((row: { slug: string }) => row.slug)).not.toContain(SECRET_SLUG);
      expect(JSON.stringify(searchRows)).not.toContain('secret sales candidate');

      const queryResult = await callAs('query', { query: SHARED_QUERY, limit: 10 });
      expect(queryResult.isError).toBeUndefined();
      const queryRows = parseToolJson(queryResult);
      expect(queryRows.map((row: { slug: string }) => row.slug)).toContain(VISIBLE_SLUG);
      expect(queryRows.map((row: { slug: string }) => row.slug)).not.toContain(SECRET_SLUG);
      expect(JSON.stringify(queryRows)).not.toContain('secret sales candidate');

      const captureRows = await waitFor(async () => {
        const rows = await engine.executeRaw<{ retrieved_slugs: unknown }>(
          `SELECT retrieved_slugs
             FROM eval_candidates
            WHERE tool_name IN ('search', 'query')
            ORDER BY id DESC
            LIMIT 2`,
        );
        return rows.length >= 2 ? rows : null;
      });
      expect(captureRows).not.toBeNull();
      for (const row of captureRows ?? []) {
        const slugs = parsePgTextArray(row.retrieved_slugs);
        expect(slugs).toContain(VISIBLE_SLUG);
        expect(slugs).not.toContain(SECRET_SLUG);
      }

      const retrievalRows = await waitFor(async () => {
        const rows = await engine.executeRaw<{ slug: string; last_retrieved_at: unknown }>(
          `SELECT slug, last_retrieved_at
             FROM pages
            WHERE slug = ANY($1::text[])
            ORDER BY slug ASC`,
          [[VISIBLE_SLUG, SECRET_SLUG]],
        );
        const visible = rows.find((row) => row.slug === VISIBLE_SLUG);
        return visible?.last_retrieved_at ? rows : null;
      });
      expect(retrievalRows).not.toBeNull();
      const bySlug = new Map((retrievalRows ?? []).map((row) => [row.slug, row.last_retrieved_at]));
      expect(bySlug.get(VISIBLE_SLUG)).toBeTruthy();
      expect(bySlug.get(SECRET_SLUG)).toBeNull();
    } finally {
      if (previousContributorMode === undefined) {
        delete process.env.GBRAIN_CONTRIBUTOR_MODE;
      } else {
        process.env.GBRAIN_CONTRIBUTOR_MODE = previousContributorMode;
      }
    }
  });
});
