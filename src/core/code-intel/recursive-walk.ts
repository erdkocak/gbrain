/**
 * v0.34 W3 — recursive caller (blast) / callee (flow) walks.
 *
 * Wraps the single-hop engine methods (getCallersOf, getCalleesOf) in a
 * BFS that returns depth-grouped responses. Bounded by depth + max_nodes
 * caps + cycle detection via visited-set.
 *
 * Response envelope (shared by code_blast + code_flow):
 *   { result: 'ok' | 'not_found' | 'ambiguous' | 'unsupported_language',
 *     depth_groups?: [{ depth, nodes, confidence }, ...],
 *     cycles_detected?: bool,
 *     truncation?: 'none' | 'max_nodes' | 'depth_cap' | 'both',
 *     freshness?: 'fresh' | 'partial',
 *     did_you_mean?: [{ symbol_qualified, score }],
 *     candidates?: [{ symbol_qualified, lang, file, lines }] }
 */
import type { BrainEngine } from '../engine.ts';
import type { CodeEdgeResult } from '../types.ts';
import { buildReadablePolicyClause, normalizeReadablePolicyIds } from '../search/sql-ranking.ts';
import { classifySink, type SinkKind } from './sinks/index.ts';

export type WalkDirection = 'callers' | 'callees';

export interface WalkOpts {
  /** Direction: callers (blast) or callees (flow). */
  direction: WalkDirection;
  /** Hard cap on hop count. Default 5 for blast, 8 for flow. */
  depth?: number;
  /** Hard cap on total nodes returned. Default 200. */
  maxNodes?: number;
  /** Source filter; v0.34 is source-scoped. */
  sourceId: string;
  /** Optional readable-policy scope. Undefined preserves trusted/local behavior. */
  readablePolicyIds?: string[];
  /** Forces exact-string match (skips bare-name disambiguation). */
  exact?: boolean;
}

export interface WalkNode {
  symbol: string;
  /** Origin chunk for the edge, when known. */
  chunk_id?: number;
  /** Sink kind for terminal nodes in code_flow. */
  sink_kind?: SinkKind;
}

export interface DepthGroup {
  depth: number;
  nodes: WalkNode[];
  /** confidence = 1 / (1 + 0.3 * depth), clamped to [0.05, 1.0] */
  confidence: number;
}

export type WalkResult =
  | {
      result: 'ok';
      depth_groups: DepthGroup[];
      cycles_detected: boolean;
      truncation: 'none' | 'max_nodes' | 'depth_cap' | 'both';
      freshness: 'fresh' | 'partial';
      terminal_nodes?: { symbol: string; sink_kind: SinkKind }[];
    }
  | { result: 'not_found'; did_you_mean: { symbol_qualified: string; score: number }[] }
  | { result: 'ambiguous'; candidates: { symbol_qualified: string; lang?: string; file?: string; lines?: string }[] }
  | { result: 'unsupported_language'; supported: readonly string[] };

const SUPPORTED_LANGS = ['typescript', 'tsx', 'javascript', 'python'] as const;

function clampConfidence(depth: number): number {
  const c = 1.0 / (1 + 0.3 * depth);
  return Math.max(0.05, Math.min(1.0, c));
}

/**
 * Try to disambiguate a bare-name input to a qualified symbol. Returns:
 *   - a single match → returns that string (caller proceeds with walk)
 *   - 2+ matches → caller emits {result:'ambiguous', candidates}
 *   - 0 matches  → caller emits {result:'not_found', did_you_mean}
 */
async function disambiguateSymbol(
  engine: BrainEngine,
  bare: string,
  sourceId: string,
  readablePolicyIds?: string[],
): Promise<{ matches: string[]; suggestions: { symbol_qualified: string; score: number }[] }> {
  try {
    const exactParams: unknown[] = [sourceId, bare];
    const exactPolicy = appendReadablePolicyFilter(readablePolicyIds, exactParams, 'pages');
    // Exact-match candidates first: anything with symbol_name = bare
    const exact = await engine.executeRaw<{ symbol_name_qualified: string }>(
      `SELECT DISTINCT symbol_name_qualified
         FROM content_chunks
         JOIN pages ON pages.id = content_chunks.page_id
        WHERE pages.source_id = $1
          AND symbol_name_qualified IS NOT NULL
          AND (symbol_name = $2 OR symbol_name_qualified = $2)
          ${exactPolicy}
        LIMIT 25`,
      exactParams,
    );
    const matches = exact.map((r) => r.symbol_name_qualified);
    if (matches.length > 0) return { matches, suggestions: [] };

    const fuzzyParams: unknown[] = [sourceId, `%${bare}%`];
    const fuzzyPolicy = appendReadablePolicyFilter(readablePolicyIds, fuzzyParams, 'pages');
    // No exact match — try trigram similarity for did_you_mean. Many
    // engines don't have pg_trgm by default; fall back to LIKE-prefix.
    const fuzzy = await engine.executeRaw<{ symbol_name_qualified: string }>(
      `SELECT DISTINCT symbol_name_qualified
         FROM content_chunks
         JOIN pages ON pages.id = content_chunks.page_id
        WHERE pages.source_id = $1
          AND symbol_name_qualified IS NOT NULL
          AND symbol_name_qualified ILIKE $2
          ${fuzzyPolicy}
        LIMIT 5`,
      fuzzyParams,
    );
    return {
      matches: [],
      suggestions: fuzzy.map((r) => ({
        symbol_qualified: r.symbol_name_qualified,
        score: 0.5, // placeholder; v0.34.1 wires real trigram score
      })),
    };
  } catch {
    return { matches: [], suggestions: [] };
  }
}

/**
 * Detect the language of a qualified symbol by looking at the owning
 * chunk's language. Returns null when not found.
 */
async function detectSymbolLanguage(
  engine: BrainEngine,
  qualified: string,
  sourceId: string,
  readablePolicyIds?: string[],
): Promise<string | null> {
  try {
    const params: unknown[] = [sourceId, qualified];
    const policyFilter = appendReadablePolicyFilter(readablePolicyIds, params, 'pages');
    const rows = await engine.executeRaw<{ language: string | null }>(
      `SELECT content_chunks.language
         FROM content_chunks
         JOIN pages ON pages.id = content_chunks.page_id
        WHERE pages.source_id = $1
          AND content_chunks.symbol_name_qualified = $2
          ${policyFilter}
        LIMIT 1`,
      params,
    );
    return rows[0]?.language ?? null;
  } catch {
    return null;
  }
}

async function symbolIsReadable(
  engine: BrainEngine,
  qualified: string,
  sourceId: string,
  readablePolicyIds?: string[],
): Promise<boolean> {
  const normalized = normalizeReadablePolicyIds(readablePolicyIds);
  if (!normalized) return true;
  if (normalized.length === 0) return false;
  try {
    const params: unknown[] = [sourceId, qualified];
    const policyFilter = appendReadablePolicyFilter(normalized, params, 'pages');
    const rows = await engine.executeRaw<{ ok: number }>(
      `SELECT 1 AS ok
         FROM content_chunks
         JOIN pages ON pages.id = content_chunks.page_id
        WHERE pages.source_id = $1
          AND content_chunks.symbol_name_qualified = $2
          ${policyFilter}
        LIMIT 1`,
      params,
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function filterReadableWalkEdges(
  engine: BrainEngine,
  edges: CodeEdgeResult[],
  sourceId: string,
  readablePolicyIds?: string[],
): Promise<CodeEdgeResult[]> {
  const normalized = normalizeReadablePolicyIds(readablePolicyIds);
  if (!normalized) return edges;
  if (normalized.length === 0 || edges.length === 0) return [];

  const chunkIds = [...new Set(
    edges
      .flatMap((edge) => [edge.from_chunk_id, edge.to_chunk_id])
      .filter((id): id is number => Number.isInteger(id)),
  )];
  const readableChunks = await readableCodeChunkIds(engine, chunkIds, sourceId, normalized);

  const symbols = [...new Set(
    edges
      .flatMap((edge) => [edge.from_symbol_qualified, edge.to_symbol_qualified])
      .filter((symbol): symbol is string => typeof symbol === 'string' && symbol.trim().length > 0),
  )];
  const readableSymbols = await readableCodeSymbols(engine, symbols, sourceId, normalized);

  return edges.filter((edge) => {
    if (!readableChunks.has(edge.from_chunk_id)) return false;
    if (edge.to_chunk_id != null && !readableChunks.has(edge.to_chunk_id)) return false;
    return readableSymbols.has(edge.from_symbol_qualified)
      && readableSymbols.has(edge.to_symbol_qualified);
  });
}

async function readableCodeChunkIds(
  engine: BrainEngine,
  chunkIds: number[],
  sourceId: string,
  readablePolicyIds: string[],
): Promise<Set<number>> {
  if (chunkIds.length === 0) return new Set();
  const params: unknown[] = [chunkIds, sourceId];
  params.push(readablePolicyIds);
  const rows = await engine.executeRaw<{ chunk_id: number }>(
    `SELECT cc.id AS chunk_id
       FROM content_chunks cc
       JOIN pages ON pages.id = cc.page_id
      WHERE cc.id = ANY($1::int[])
        AND pages.source_id = $2
        AND pages.deleted_at IS NULL
        ${buildReadablePolicyClause('pages', '$3')}`,
    params,
  );
  return new Set(rows.map((row) => Number(row.chunk_id)));
}

async function readableCodeSymbols(
  engine: BrainEngine,
  symbols: string[],
  sourceId: string,
  readablePolicyIds: string[],
): Promise<Set<string>> {
  if (symbols.length === 0) return new Set();
  const params: unknown[] = [symbols, sourceId];
  params.push(readablePolicyIds);
  const rows = await engine.executeRaw<{ symbol_name_qualified: string }>(
    `SELECT DISTINCT content_chunks.symbol_name_qualified
       FROM content_chunks
       JOIN pages ON pages.id = content_chunks.page_id
      WHERE content_chunks.symbol_name_qualified = ANY($1::text[])
        AND pages.source_id = $2
        AND pages.deleted_at IS NULL
        ${buildReadablePolicyClause('pages', '$3')}`,
    params,
  );
  return new Set(rows.map((row) => row.symbol_name_qualified));
}

function appendReadablePolicyFilter(
  readablePolicyIds: string[] | undefined,
  params: unknown[],
  pageAlias: string,
): string {
  const normalized = normalizeReadablePolicyIds(readablePolicyIds);
  if (!normalized) return '';
  if (normalized.length === 0) return 'AND FALSE';
  params.push(normalized);
  return buildReadablePolicyClause(pageAlias, `$${params.length}`);
}

/**
 * BFS recursive walk. Returns the depth-grouped result envelope.
 */
export async function runRecursiveWalk(
  engine: BrainEngine,
  symbol: string,
  opts: WalkOpts,
): Promise<WalkResult> {
  const depthCap = opts.depth ?? (opts.direction === 'callers' ? 5 : 8);
  const maxNodes = opts.maxNodes ?? 200;

  // Step 1: disambiguate bare name (skip when --exact).
  let qualifiedStart = symbol;
  if (!opts.exact && !symbol.includes('::')) {
    const { matches, suggestions } = await disambiguateSymbol(engine, symbol, opts.sourceId, opts.readablePolicyIds);
    if (matches.length === 0) return { result: 'not_found', did_you_mean: suggestions };
    if (matches.length > 1) {
      return {
        result: 'ambiguous',
        candidates: matches.map((m) => ({ symbol_qualified: m })),
      };
    }
    qualifiedStart = matches[0]!;
  }

  if (!(await symbolIsReadable(engine, qualifiedStart, opts.sourceId, opts.readablePolicyIds))) {
    return { result: 'not_found', did_you_mean: [] };
  }

  // Step 2: language gate (per D18 honest scope).
  const lang = await detectSymbolLanguage(engine, qualifiedStart, opts.sourceId, opts.readablePolicyIds);
  if (lang && !SUPPORTED_LANGS.includes(lang as (typeof SUPPORTED_LANGS)[number])) {
    return { result: 'unsupported_language', supported: SUPPORTED_LANGS };
  }

  // Step 3: BFS walk.
  const visited = new Set<string>([qualifiedStart]);
  const depthGroups: DepthGroup[] = [];
  let cyclesDetected = false;
  let truncation: 'none' | 'max_nodes' | 'depth_cap' | 'both' = 'none';
  let totalNodes = 0;
  let freshness: 'fresh' | 'partial' = 'fresh';
  const terminalNodes: { symbol: string; sink_kind: SinkKind }[] = [];

  let frontier = [qualifiedStart];
  for (let d = 1; d <= depthCap; d++) {
    const nextFrontier: string[] = [];
    const nodesThisDepth: WalkNode[] = [];

    for (const sym of frontier) {
      let edges: CodeEdgeResult[];
      try {
        edges =
          opts.direction === 'callers'
            ? await engine.getCallersOf(sym, { sourceId: opts.sourceId, limit: maxNodes })
            : await engine.getCalleesOf(sym, { sourceId: opts.sourceId, limit: maxNodes });
      } catch {
        edges = [];
      }
      edges = await filterReadableWalkEdges(engine, edges, opts.sourceId, opts.readablePolicyIds);

      // freshness check: any edge whose owning chunk has edges_backfilled_at IS NULL
      // → partial. v0.34 W3b's getCachedOrCompute will gate this further.

      for (const e of edges) {
        const next =
          opts.direction === 'callers' ? e.from_symbol_qualified : e.to_symbol_qualified;
        if (!next || next === sym) continue;
        if (visited.has(next)) {
          cyclesDetected = true;
          continue;
        }
        if (!(await symbolIsReadable(engine, next, opts.sourceId, opts.readablePolicyIds))) continue;
        if (totalNodes >= maxNodes) {
          truncation = truncation === 'depth_cap' ? 'both' : 'max_nodes';
          break;
        }
        visited.add(next);
        totalNodes += 1;
        const node: WalkNode = { symbol: next, chunk_id: e.from_chunk_id };
        // Tag sinks for callees direction.
        if (opts.direction === 'callees' && lang) {
          const kind = classifySink(next, lang);
          if (kind !== 'unknown') {
            node.sink_kind = kind;
            terminalNodes.push({ symbol: next, sink_kind: kind });
          }
        }
        nodesThisDepth.push(node);
        nextFrontier.push(next);
      }
      if (truncation === 'max_nodes' || truncation === 'both') break;
    }

    if (nodesThisDepth.length > 0) {
      depthGroups.push({
        depth: d,
        nodes: nodesThisDepth,
        confidence: clampConfidence(d),
      });
    }
    if (nextFrontier.length === 0) break;
    if (d === depthCap && nextFrontier.length > 0) {
      truncation = truncation === 'max_nodes' ? 'both' : 'depth_cap';
    }
    if (truncation === 'max_nodes' || truncation === 'both') break;
    frontier = nextFrontier;
  }

  const result: WalkResult = {
    result: 'ok',
    depth_groups: depthGroups,
    cycles_detected: cyclesDetected,
    truncation,
    freshness,
  };
  if (opts.direction === 'callees' && terminalNodes.length > 0) {
    (result as Extract<WalkResult, { result: 'ok' }>).terminal_nodes = terminalNodes;
  }
  return result;
}
