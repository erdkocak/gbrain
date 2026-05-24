import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { applyCompanyModeSkeleton } from '../src/core/company-mode.ts';
import { hybridSearchCached } from '../src/core/search/hybrid.ts';
import { SemanticQueryCache, secureCompanyCacheSourceIds } from '../src/core/search/query-cache.ts';
import type { HybridSearchMeta } from '../src/core/types.ts';
import {
  configureGateway,
  resetGateway,
  __setEmbedTransportForTests,
} from '../src/core/ai/gateway.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

const ENG_POLICY = 'engineering-notes';
const VISIBLE_SLUG = 'docs/engineering/cache-visible';
const QUERY = 'company cache safety marker';
const DIMS = 1536;

beforeAll(async () => {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: DIMS,
    env: { OPENAI_API_KEY: 'sk-test' },
  });
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
  await resetPgliteState(engine);
  await applyCompanyModeSkeleton(engine);
  await engine.setConfig('search.cache.enabled', 'true');
  await engine.setConfig('search.reranker.enabled', 'false');
  await engine.executeRaw('DELETE FROM query_cache');
});

function embedding(): Float32Array {
  const out = new Float32Array(DIMS);
  out[7] = 1;
  out[8] = 0.25;
  return out;
}

function stubEmbeddings(): void {
  __setEmbedTransportForTests(async (args: any) => ({
    embeddings: args.values.map(() => Array.from(embedding())),
  }) as any);
}

async function seedVisiblePage(): Promise<void> {
  await engine.putPage(VISIBLE_SLUG, {
    type: 'doc',
    title: VISIBLE_SLUG,
    compiled_truth: `${QUERY} visible engineering text`,
    timeline: '',
    frontmatter: {
      visibility_policy_id: ENG_POLICY,
      visibility_policy_ids: [ENG_POLICY],
    },
  }, { sourceId: 'company' });
  await engine.upsertChunks(VISIBLE_SLUG, [{
    chunk_index: 0,
    chunk_text: `${QUERY} visible engineering text`,
    chunk_source: 'compiled_truth',
    embedding: embedding(),
    modality: 'text',
  }], { sourceId: 'company' });
}

async function cacheRowCount(): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM query_cache`,
  );
  return rows[0]?.n ?? 0;
}

describe('company cache safety', () => {
  test('company source cache rows are excluded from management summaries unless explicitly included', async () => {
    const cache = new SemanticQueryCache(engine);
    await cache.store('default query', embedding(), [{
      slug: 'default/result',
      page_id: 1,
      title: 'default',
      type: 'doc',
      chunk_text: 'default text',
      chunk_source: 'compiled_truth',
      chunk_id: 1,
      chunk_index: 0,
      score: 1,
      stale: false,
    }], { vector_enabled: true, detail_resolved: null, expansion_applied: false }, { sourceId: 'default' });
    await cache.store('company query', embedding(), [{
      slug: 'company/secret',
      page_id: 2,
      title: 'company',
      type: 'doc',
      chunk_text: 'company text',
      chunk_source: 'compiled_truth',
      chunk_id: 2,
      chunk_index: 0,
      score: 1,
      stale: false,
    }], { vector_enabled: true, detail_resolved: null, expansion_applied: false }, { sourceId: 'company' });

    const excludedSourceIds = await secureCompanyCacheSourceIds(engine);
    expect(excludedSourceIds).toEqual(['company']);
    expect((await cache.stats({ excludeSourceIds: excludedSourceIds })).total_rows).toBe(1);

    const cleared = await cache.clear({ excludeSourceIds: excludedSourceIds });
    expect(cleared).toBe(1);
    const remaining = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM query_cache ORDER BY source_id`,
    );
    expect(remaining.map((row) => row.source_id)).toEqual(['company']);
  });

  test('policy-scoped hybrid query bypasses cache lookup and writeback', async () => {
    stubEmbeddings();
    await seedVisiblePage();

    const metaBox: { current: HybridSearchMeta | null } = { current: null };
    const results = await hybridSearchCached(engine, QUERY, {
      sourceId: 'company',
      readablePolicyIds: [ENG_POLICY],
      limit: 10,
      expansion: false,
      useCache: true,
      onMeta: (value) => { metaBox.current = value; },
    });

    expect(results.map((row) => row.slug)).toContain(VISIBLE_SLUG);
    expect(metaBox.current?.cache?.status).toBe('disabled');
    expect(await cacheRowCount()).toBe(0);
  });
});
