import type { CompanyAuditObjectRef } from '../core/company-audit.ts';
import type { Operation } from '../core/operations.ts';

export interface HostedCompanyReadResultAudit {
  result_count: number;
  object_ids_or_slugs: CompanyAuditObjectRef[];
  content_or_query?: unknown;
}

const MAX_AUDIT_OBJECT_REFS = 200;

const READ_RESULT_EXCLUDED_OPERATIONS = new Set([
  'whoami',
]);

const STRING_REF_KEYS = new Set([
  'slug',
  'page_slug',
  'resolved_slug',
  'from_slug',
  'to_slug',
  'origin_slug',
  'source_slug',
  'target_slug',
  'entity_slug',
  'source_markdown_slug',
]);

const NUMBER_REF_KEYS = new Set([
  'id',
  'page_id',
  'chunk_id',
  'fact_id',
  'take_id',
  'version_id',
  'raw_data_id',
  'entry_id',
  'edge_id',
  'from_chunk_id',
  'to_chunk_id',
  'superseded_by',
  'consolidated_into',
]);

const STRING_REF_ARRAY_KEYS = new Set([
  'pages_updated',
]);

const COLLECTION_KEYS = [
  'results',
  'pages',
  'chunks',
  'facts',
  'takes',
  'links',
  'edges',
  'versions',
  'logs',
  'timeline',
  'events',
  'items',
  'nodes',
  'paths',
  'callers',
  'callees',
  'defs',
  'refs',
  'points',
  'contradictions',
  'findings',
  'anomalies',
  'salience',
  'matches',
  'files',
] as const;

const PARAM_SLUG_REF_OPERATIONS = new Set([
  'get_chunks',
  'get_versions',
  'get_raw_data',
  'get_timeline',
  'find_trajectory',
]);

const QUERY_HASH_KEYS_BY_OPERATION = new Map<string, readonly string[]>([
  ['query', ['query']],
  ['search', ['query']],
  ['search_by_image', ['query']],
  ['takes_search', ['query']],
  ['resolve_slugs', ['partial']],
  ['recall', ['grep']],
  ['code_callers', ['symbol']],
  ['code_callees', ['symbol']],
  ['code_def', ['symbol']],
  ['code_refs', ['symbol']],
  ['code_blast', ['symbol']],
  ['code_flow', ['entry_point']],
]);

export function shouldAuditHostedCompanyReadResult(op: Operation): boolean {
  return op.scope === 'read'
    && op.mutating !== true
    && !READ_RESULT_EXCLUDED_OPERATIONS.has(op.name);
}

export function buildHostedCompanyReadResultAudit(
  operation: string,
  params: Record<string, unknown>,
  result: unknown,
): HostedCompanyReadResultAudit {
  const items = primaryResultItems(operation, result);
  const resultCount = items ? items.length : singleObjectResultCount(result);
  const refs = new AuditObjectRefs();

  if (items) {
    for (const item of items) refs.addFromItem(item);
  } else if (resultCount > 0) {
    refs.addFromItem(result);
  }

  if (resultCount > 0 && PARAM_SLUG_REF_OPERATIONS.has(operation)) {
    refs.addString(params.slug);
    refs.addString(params.entity_slug);
  }

  const summary: HostedCompanyReadResultAudit = {
    result_count: resultCount,
    object_ids_or_slugs: refs.values(),
  };
  const contentOrQuery = contentOrQueryFor(operation, params);
  if (contentOrQuery !== undefined) summary.content_or_query = contentOrQuery;
  return summary;
}

function primaryResultItems(operation: string, result: unknown): unknown[] | null {
  if (Array.isArray(result)) {
    if (operation === 'resolve_slugs') return result.filter((entry) => typeof entry === 'string');
    return result;
  }
  if (!isPlainRecord(result)) return null;
  if (typeof result.error === 'string') return [];

  if (operation === 'code_blast' || operation === 'code_flow') {
    return recursiveCodeWalkItems(result);
  }

  for (const key of COLLECTION_KEYS) {
    const value = result[key];
    if (Array.isArray(value)) return value;
  }
  return null;
}

function recursiveCodeWalkItems(result: Record<string, unknown>): unknown[] {
  if (result.result !== 'ok') return [];
  const groups = Array.isArray(result.depth_groups) ? result.depth_groups : [];
  return groups.flatMap((group) => {
    if (!isPlainRecord(group) || !Array.isArray(group.nodes)) return [];
    return group.nodes;
  });
}

function singleObjectResultCount(result: unknown): number {
  if (result == null) return 0;
  if (isPlainRecord(result) && typeof result.error === 'string') return 0;
  return isPlainRecord(result) ? 1 : 0;
}

function contentOrQueryFor(operation: string, params: Record<string, unknown>): unknown | undefined {
  const keys = QUERY_HASH_KEYS_BY_OPERATION.get(operation);
  if (!keys) return undefined;
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

class AuditObjectRefs {
  private readonly refs: CompanyAuditObjectRef[] = [];
  private readonly seen = new Set<string>();

  addFromItem(item: unknown): void {
    if (typeof item === 'string') {
      this.addString(item);
      return;
    }
    if (!isPlainRecord(item)) return;

    for (const [key, value] of Object.entries(item)) {
      if (STRING_REF_KEYS.has(key)) {
        this.addString(value);
      } else if (NUMBER_REF_KEYS.has(key)) {
        this.addNumber(value);
      } else if (STRING_REF_ARRAY_KEYS.has(key) && Array.isArray(value)) {
        for (const entry of value) this.addString(entry);
      } else if (COLLECTION_KEYS.includes(key as typeof COLLECTION_KEYS[number]) && Array.isArray(value)) {
        for (const entry of value) this.addFromItem(entry);
      }
    }
  }

  addString(value: unknown): void {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 512 || /[\r\n]/.test(trimmed)) return;
    this.add(trimmed);
  }

  private addNumber(value: unknown): void {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    this.add(value);
  }

  private add(value: CompanyAuditObjectRef): void {
    if (this.refs.length >= MAX_AUDIT_OBJECT_REFS) return;
    const key = `${typeof value}:${String(value)}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.refs.push(value);
  }

  values(): CompanyAuditObjectRef[] {
    return this.refs;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
