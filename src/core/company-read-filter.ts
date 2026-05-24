import type { OperationContext } from './operations.ts';
import type { Page, SearchOpts, SearchResult } from './types.ts';

export interface CompanyReadScope {
  readablePolicyIds: Set<string>;
  allowedSourceIds: Set<string>;
}

type PagePolicyRow = {
  id?: number | string | bigint;
  slug?: string | null;
  source_id?: string | null;
  frontmatter?: unknown;
};

export function companyReadScope(ctx: OperationContext): CompanyReadScope | null {
  if (ctx.remote !== true) return null;
  const companyContext = ctx.companyRequestContext;
  if (!companyContext || companyContext.identityStatus !== 'resolved' || !companyContext.policyContextAvailable) {
    return null;
  }
  return {
    readablePolicyIds: new Set(companyContext.readablePolicyIds),
    allowedSourceIds: new Set(companyContext.allowedSources.length > 0
      ? companyContext.allowedSources
      : [companyContext.sourceId]),
  };
}

export function isCompanyReadFiltered(ctx: OperationContext): boolean {
  return companyReadScope(ctx) !== null;
}

export function companyReadableSearchOpts(ctx: OperationContext): Pick<SearchOpts, 'readablePolicyIds'> {
  const scope = companyReadScope(ctx);
  if (!scope) return {};
  return { readablePolicyIds: [...scope.readablePolicyIds].sort() };
}

export function isPageReadableForCompany(ctx: OperationContext, page: Page): boolean {
  const scope = companyReadScope(ctx);
  if (!scope) return true;
  return rowIsReadable(scope, {
    id: page.id,
    slug: page.slug,
    source_id: page.source_id,
    frontmatter: page.frontmatter,
  });
}

export function filterReadablePages<T extends Page>(ctx: OperationContext, pages: T[]): T[] {
  const scope = companyReadScope(ctx);
  if (!scope) return pages;
  return pages.filter((page) => rowIsReadable(scope, {
    id: page.id,
    slug: page.slug,
    source_id: page.source_id,
    frontmatter: page.frontmatter,
  }));
}

export async function isPageSlugReadableForCompany(
  ctx: OperationContext,
  slug: string,
  sourceId: string | undefined = ctx.sourceId,
): Promise<boolean> {
  const scope = companyReadScope(ctx);
  if (!scope) return true;
  const sourceIds = sourceId ? [sourceId] : [...scope.allowedSourceIds];
  const rows = await ctx.engine.executeRaw<PagePolicyRow>(
    `SELECT id, slug, source_id, frontmatter
       FROM pages
      WHERE slug = $1
        AND source_id = ANY($2::text[])
        AND deleted_at IS NULL`,
    [slug, sourceIds],
  );
  return rows.some((row) => rowIsReadable(scope, row));
}

export async function filterReadableSlugCandidates(
  ctx: OperationContext,
  slugs: string[],
): Promise<string[]> {
  const scope = companyReadScope(ctx);
  if (!scope || slugs.length === 0) return slugs;
  const uniqueSlugs = [...new Set(slugs)];
  const rows = await ctx.engine.executeRaw<PagePolicyRow>(
    `SELECT id, slug, source_id, frontmatter
       FROM pages
      WHERE slug = ANY($1::text[])
        AND source_id = ANY($2::text[])
        AND deleted_at IS NULL`,
    [uniqueSlugs, [...scope.allowedSourceIds]],
  );
  const readable = new Set(
    rows
      .filter((row) => row.slug && rowIsReadable(scope, row))
      .map((row) => row.slug as string),
  );
  return slugs.filter((slug) => readable.has(slug));
}

export async function filterReadablePageBackedRows<T>(
  ctx: OperationContext,
  rows: T[],
  pageIdForRow: (row: T) => number | null | undefined,
): Promise<T[]> {
  const scope = companyReadScope(ctx);
  if (!scope || rows.length === 0) return rows;
  const pageIds = [...new Set(rows.map(pageIdForRow).filter((id): id is number => Number.isInteger(id)))];
  if (pageIds.length === 0) return [];
  const readable = await readablePageIds(ctx, scope, pageIds);
  return rows.filter((row) => {
    const pageId = pageIdForRow(row);
    return typeof pageId === 'number' && readable.has(pageId);
  });
}

export async function filterReadableSearchResults<T extends SearchResult>(
  ctx: OperationContext,
  results: T[],
): Promise<T[]> {
  return filterReadablePageBackedRows(ctx, results, (row) => row.page_id);
}

export async function filterReadablePageRefRows<T>(
  ctx: OperationContext,
  rows: T[],
  refsForRow: (row: T) => Array<{ slug: string | null | undefined; source_id?: string | null | undefined }>,
): Promise<T[]> {
  const scope = companyReadScope(ctx);
  if (!scope || rows.length === 0) return rows;
  const refs = rows.flatMap(refsForRow).filter((ref): ref is { slug: string; source_id?: string | null } => (
    typeof ref.slug === 'string' && ref.slug.trim().length > 0
  ));
  if (refs.length === 0) return [];
  const readable = await readablePageRefs(ctx, scope, refs);
  return rows.filter((row) => {
    const rowRefs = refsForRow(row)
      .filter((ref): ref is { slug: string; source_id?: string | null } => (
        typeof ref.slug === 'string' && ref.slug.trim().length > 0
      ));
    if (rowRefs.length === 0) return false;
    return rowRefs.every((ref) => {
      const sourceIds = ref.source_id ? [ref.source_id] : [...scope.allowedSourceIds];
      return sourceIds.some((sourceId) => readable.has(refKey(sourceId, ref.slug)));
    });
  });
}

export async function filterReadableAnomalies<T extends { page_slugs: string[]; count: number; baseline_mean: number; baseline_stddev: number; sigma_observed: number }>(
  ctx: OperationContext,
  anomalies: T[],
): Promise<T[]> {
  const scope = companyReadScope(ctx);
  if (!scope || anomalies.length === 0) return anomalies;
  const slugs = [...new Set(anomalies.flatMap((entry) => entry.page_slugs))];
  const readableSlugs = new Set(await filterReadableSlugCandidates(ctx, slugs));
  return anomalies.flatMap((entry) => {
    const page_slugs = entry.page_slugs.filter((slug) => readableSlugs.has(slug));
    if (page_slugs.length === 0) return [];
    return [{
      ...entry,
      page_slugs,
      count: page_slugs.length,
      baseline_mean: 0,
      baseline_stddev: 0,
      sigma_observed: 0,
    }];
  });
}

export function pageVisibilityPolicyIds(frontmatter: Record<string, unknown>): string[] {
  const many = frontmatter.visibility_policy_ids;
  if (Array.isArray(many)) {
    const ids = many.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
    if (ids.length > 0) return [...new Set(ids.map((entry) => entry.trim()))].sort();
  }
  const one = frontmatter.visibility_policy_id;
  return typeof one === 'string' && one.trim().length > 0 ? [one.trim()] : [];
}

async function readablePageIds(
  ctx: OperationContext,
  scope: CompanyReadScope,
  pageIds: number[],
): Promise<Set<number>> {
  const rows = await ctx.engine.executeRaw<PagePolicyRow>(
    `SELECT id, slug, source_id, frontmatter
       FROM pages
      WHERE id = ANY($1::int[])
        AND deleted_at IS NULL`,
    [pageIds],
  );
  return new Set(
    rows
      .filter((row) => row.id !== undefined && rowIsReadable(scope, row))
      .map((row) => Number(row.id)),
  );
}

async function readablePageRefs(
  ctx: OperationContext,
  scope: CompanyReadScope,
  refs: Array<{ slug: string; source_id?: string | null }>,
): Promise<Set<string>> {
  const expanded = refs.flatMap((ref) => {
    const sourceIds = ref.source_id ? [ref.source_id] : [...scope.allowedSourceIds];
    return sourceIds.map((sourceId) => ({ slug: ref.slug, source_id: sourceId }));
  });
  const deduped = [...new Map(expanded.map((ref) => [refKey(ref.source_id, ref.slug), ref])).values()];
  if (deduped.length === 0) return new Set();
  const rows = await ctx.engine.executeRaw<PagePolicyRow>(
    `SELECT p.id, p.slug, p.source_id, p.frontmatter
       FROM pages p
       JOIN unnest($1::text[], $2::text[]) AS requested(slug, source_id)
         ON p.slug = requested.slug AND p.source_id = requested.source_id
      WHERE p.deleted_at IS NULL`,
    [deduped.map((ref) => ref.slug), deduped.map((ref) => ref.source_id)],
  );
  return new Set(
    rows
      .filter((row) => row.slug && row.source_id && rowIsReadable(scope, row))
      .map((row) => refKey(row.source_id as string, row.slug as string)),
  );
}

function rowIsReadable(scope: CompanyReadScope, row: PagePolicyRow): boolean {
  const sourceId = typeof row.source_id === 'string' ? row.source_id : null;
  if (!sourceId || !scope.allowedSourceIds.has(sourceId)) return false;
  const frontmatter = normalizeFrontmatter(row.frontmatter);
  const policyIds = pageVisibilityPolicyIds(frontmatter);
  return policyIds.some((policyId) => scope.readablePolicyIds.has(policyId));
}

function normalizeFrontmatter(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

function refKey(sourceId: string, slug: string): string {
  return `${sourceId}\0${slug}`;
}
