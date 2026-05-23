import type { BrainEngine } from './engine.ts';
import type { Page } from './types.ts';
import {
  COMPANY_SCHEMA_PACK_NAME,
} from './company-layout.ts';
import {
  COMPANY_MODE_KIND,
  COMPANY_PRIMARY_SOURCE_ID,
  COMPANY_TRUST_MODE,
} from './company-mode.ts';

export const COMPANY_RETRIEVAL_DISABLED_SURFACES = [
  'query_cache',
  'hot_memory_meta',
  'code_traversal_cache',
  'code_intelligence_reads',
  'analytics_reads',
  'dream_cycle_outputs',
] as const;

export class CompanyRetrieveError extends Error {
  constructor(
    public code:
      | 'company_mode_required'
      | 'source_missing'
      | 'question_required'
      | 'bad_limit',
    message: string,
  ) {
    super(message);
    this.name = 'CompanyRetrieveError';
  }
}

export interface CompanyRetrieveInput {
  question: string;
  sourceId?: string;
  project?: string;
  limit?: number;
}

export interface CompanyCitation {
  role: 'decision' | 'source' | 'evidence';
  slug: string;
  title: string;
  page_type: string;
}

export interface CompanyDecisionHit {
  slug: string;
  title: string;
  decision: string;
  decision_date: string | null;
  status: string | null;
  owner: string | null;
  projects: string[];
  citations: CompanyCitation[];
  score: number;
}

export interface CompanyRetrieveResult {
  source_id: string;
  trusted_workspace: true;
  schema_pack: typeof COMPANY_SCHEMA_PACK_NAME;
  question: string;
  answer: string;
  decisions: CompanyDecisionHit[];
  citations: CompanyCitation[];
  retrieval_mode: 'trusted-workspace-local-direct';
  disabled_surfaces: typeof COMPANY_RETRIEVAL_DISABLED_SURFACES[number][];
}

interface WorkspaceContext {
  sourceId: string;
  limit: number;
}

export async function answerCompanyQuestion(
  engine: BrainEngine,
  input: CompanyRetrieveInput,
): Promise<CompanyRetrieveResult> {
  const question = input.question.trim();
  if (!question) {
    throw new CompanyRetrieveError('question_required', 'Company retrieval requires a question.');
  }
  const ctx = await resolveCompanyWorkspace(engine, input);
  const decisions = await listDecisionPages(engine, ctx.sourceId);
  const ranked = rankDecisionPages(decisions, question, input.project)
    .slice(0, ctx.limit);
  const hits = await Promise.all(ranked.map((entry) => buildDecisionHit(engine, ctx.sourceId, entry.page, entry.score)));
  const citations = dedupeCitations(hits.flatMap((hit) => hit.citations));

  return {
    source_id: ctx.sourceId,
    trusted_workspace: true,
    schema_pack: COMPANY_SCHEMA_PACK_NAME,
    question,
    answer: renderAnswer(question, hits),
    decisions: hits,
    citations,
    retrieval_mode: 'trusted-workspace-local-direct',
    disabled_surfaces: [...COMPANY_RETRIEVAL_DISABLED_SURFACES],
  };
}

async function resolveCompanyWorkspace(
  engine: BrainEngine,
  input: CompanyRetrieveInput,
): Promise<WorkspaceContext> {
  const brainMode = await engine.getConfig('brain.mode');
  const companyMode = await engine.getConfig('company.mode');
  if (brainMode !== COMPANY_MODE_KIND || companyMode !== COMPANY_TRUST_MODE) {
    throw new CompanyRetrieveError(
      'company_mode_required',
      'Company retrieval requires a trusted-workspace company brain. Run `gbrain init --company` first.',
    );
  }

  const sourceId = input.sourceId
    ?? await engine.getConfig('company.primary_source_id')
    ?? COMPANY_PRIMARY_SOURCE_ID;
  const rows = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM sources WHERE id = $1 AND archived = false`,
    [sourceId],
  );
  if (rows.length === 0) {
    throw new CompanyRetrieveError(
      'source_missing',
      `Company source "${sourceId}" is missing. Re-run \`gbrain init --company\` or create the source first.`,
    );
  }

  const limit = input.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new CompanyRetrieveError('bad_limit', 'Company retrieval --limit must be an integer from 1 to 100.');
  }

  return { sourceId, limit };
}

async function listDecisionPages(engine: BrainEngine, sourceId: string): Promise<Page[]> {
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT slug
       FROM pages
      WHERE source_id = $1
        AND deleted_at IS NULL
        AND type = 'decision'
      ORDER BY updated_at DESC, slug ASC
      LIMIT 500`,
    [sourceId],
  );
  const pages: Page[] = [];
  for (const row of rows) {
    const page = await engine.getPage(row.slug, { sourceId });
    if (page) pages.push(page);
  }
  return pages;
}

function rankDecisionPages(
  pages: Page[],
  question: string,
  project?: string,
): Array<{ page: Page; score: number }> {
  const tokens = queryTokens(question);
  const generic = tokens.length === 0 || isGenericDecisionQuestion(question);
  const projectFilter = project?.trim().toLowerCase();
  const ranked: Array<{ page: Page; score: number }> = [];

  for (const page of pages) {
    const projects = arrayOfStrings(page.frontmatter.projects);
    if (projectFilter && !projects.some((p) => p.toLowerCase() === projectFilter)) continue;

    const haystacks = [
      page.title,
      page.slug,
      page.compiled_truth,
      stringOrEmpty(page.frontmatter.source_quote),
      ...projects,
    ].map((v) => v.toLowerCase());

    let score = generic ? 1 : 0;
    for (const token of tokens) {
      if (haystacks[0]!.includes(token)) score += 4;
      if (haystacks[1]!.includes(token)) score += 3;
      if (haystacks[2]!.includes(token)) score += 2;
      if (haystacks.slice(3).some((h) => h.includes(token))) score += 1;
    }
    if (projectFilter) score += 5;
    if (score > 0) ranked.push({ page, score });
  }

  return ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const bd = dateForPage(b.page) ?? '';
    const ad = dateForPage(a.page) ?? '';
    if (bd !== ad) return bd.localeCompare(ad);
    return a.page.slug.localeCompare(b.page.slug);
  });
}

async function buildDecisionHit(
  engine: BrainEngine,
  sourceId: string,
  page: Page,
  score: number,
): Promise<CompanyDecisionHit> {
  const citationSlugs = [
    page.slug,
    ...arrayOfStrings(page.frontmatter.derived_from),
    ...arrayOfStrings(page.frontmatter.evidence_refs),
  ];
  const citations: CompanyCitation[] = [];
  for (const slug of citationSlugs) {
    const cited = slug === page.slug ? page : await engine.getPage(slug, { sourceId });
    if (!cited) continue;
    citations.push({
      role: slug === page.slug ? 'decision' : (cited.type === 'evidence' ? 'evidence' : 'source'),
      slug: cited.slug,
      title: cited.title,
      page_type: cited.type,
    });
  }

  return {
    slug: page.slug,
    title: page.title,
    decision: decisionText(page),
    decision_date: dateForPage(page),
    status: stringOrNull(page.frontmatter.status),
    owner: stringOrNull(page.frontmatter.owner),
    projects: arrayOfStrings(page.frontmatter.projects),
    citations: dedupeCitations(citations),
    score,
  };
}

function renderAnswer(question: string, hits: CompanyDecisionHit[]): string {
  if (hits.length === 0) {
    return `No company decisions matched "${question}" in the trusted workspace.`;
  }
  const lines = [
    `Found ${hits.length} company decision${hits.length === 1 ? '' : 's'} in the trusted workspace:`,
  ];
  for (const hit of hits) {
    const date = hit.decision_date ? `${hit.decision_date}: ` : '';
    const owner = hit.owner ? ` Owner: ${hit.owner}.` : '';
    const citations = formatInlineCitations(hit.citations);
    lines.push(`- ${date}${hit.decision}${owner} ${citations}`.trimEnd());
  }
  return lines.join('\n');
}

function formatInlineCitations(citations: CompanyCitation[]): string {
  const decision = citations.find((c) => c.role === 'decision');
  const sources = citations.filter((c) => c.role === 'source');
  const evidence = citations.filter((c) => c.role === 'evidence');
  const parts: string[] = [];
  if (decision) parts.push(`decision: ${decision.slug}`);
  if (sources.length > 0) parts.push(`source: ${sources.map((c) => c.slug).join(', ')}`);
  if (evidence.length > 0) parts.push(`evidence: ${evidence.map((c) => c.slug).join(', ')}`);
  return parts.length > 0 ? `[${parts.join('; ')}]` : '[source: unavailable]';
}

function decisionText(page: Page): string {
  const section = headingSection(page.compiled_truth, 'Decision');
  const candidate = firstMeaningfulLine(section ?? page.compiled_truth);
  if (candidate) return candidate;
  return page.title.replace(/^Decision:\s*/i, '').trim() || page.title;
}

function headingSection(content: string, heading: string): string | null {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^##+\\s+${escapeRegExp(heading)}\\s*$`, 'i').test(line.trim()));
  if (start === -1) return null;
  const collected: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+\S/.test(lines[i]!.trim())) break;
    collected.push(lines[i]!);
  }
  const section = collected.join('\n').trim();
  return section || null;
}

function firstMeaningfulLine(content: string): string | null {
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/^\s*[-*]\s+/, '').trim();
    if (!line || line.startsWith('>')) continue;
    if (/^\[\[.+\]\]$/.test(line)) continue;
    return line.replace(/\s+/g, ' ');
  }
  return null;
}

function queryTokens(question: string): string[] {
  return [...new Set(
    question
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
  )];
}

function isGenericDecisionQuestion(question: string): boolean {
  return /\bwhat\s+did\s+we\s+decide\b/i.test(question)
    || /\bdecisions?\b/i.test(question);
}

const STOPWORDS = new Set([
  'what', 'when', 'where', 'which', 'who', 'whom', 'whose', 'why', 'how',
  'did', 'does', 'were', 'was', 'are', 'our', 'the', 'and', 'for', 'with',
  'about', 'from', 'that', 'this', 'company', 'decide', 'decided', 'decision',
  'decisions', 'status', 'latest', 'recent',
]);

function dateForPage(page: Page): string | null {
  const candidates = [
    page.frontmatter.decision_date,
    page.frontmatter.event_date,
    page.frontmatter.date,
    typeof page.frontmatter.captured_at === 'string' ? page.frontmatter.captured_at.slice(0, 10) : null,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  }
  return null;
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function dedupeCitations(citations: CompanyCitation[]): CompanyCitation[] {
  const seen = new Set<string>();
  const out: CompanyCitation[] = [];
  for (const citation of citations) {
    const key = `${citation.role}:${citation.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(citation);
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
