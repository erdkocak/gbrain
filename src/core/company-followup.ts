import type { BrainEngine } from './engine.ts';
import type { Page } from './types.ts';
import {
  COMPANY_SCHEMA_PACK_NAME,
} from './company-layout.ts';
import {
  buildCompanyHostedSurfaceConfig,
  type CompanyHostedSurfaceConfig,
} from './company-hosted-surface.ts';
import {
  COMPANY_MODE_KIND,
  COMPANY_PRIMARY_SOURCE_ID,
  COMPANY_TRUST_MODE,
} from './company-mode.ts';

export const COMPANY_FOLLOWUP_DISABLED_ACTIONS = [
  'send_email',
  'post_slack',
  'create_ticket',
  'calendar_invite',
  'webhook',
  'external_api',
  'shell_job',
  'subagent_job',
] as const;

export const COMPANY_FOLLOWUP_DISABLED_SURFACES = [
  'broad_hosted_writes_for_normal_users',
  'external_execution',
  'cron_webhooks',
  'minion_subagent_orchestration',
  'publishing_export',
] as const;

export class CompanyFollowUpError extends Error {
  constructor(
    public code:
      | 'company_mode_required'
      | 'source_missing'
      | 'bad_limit',
    message: string,
  ) {
    super(message);
    this.name = 'CompanyFollowUpError';
  }
}

export interface CompanyFollowUpInput {
  sourceId?: string;
  owner?: string;
  project?: string;
  limit?: number;
  includeClosed?: boolean;
}

export interface CompanyFollowUpCitation {
  role: 'follow_up' | 'decision' | 'source' | 'evidence';
  slug: string;
  title: string;
  page_type: string;
}

export interface CompanyFollowUpDraft {
  kind: 'action' | 'commitment';
  slug: string;
  title: string;
  summary: string;
  owner: string | null;
  status: string | null;
  due_date: string | null;
  projects: string[];
  draft: string;
  citations: CompanyFollowUpCitation[];
}

export interface CompanyFollowUpDecisionContext {
  slug: string;
  title: string;
  decision: string;
  decision_date: string | null;
  projects: string[];
}

export interface CompanyFollowUpDraftResult {
  source_id: string;
  trusted_workspace: true;
  schema_pack: typeof COMPANY_SCHEMA_PACK_NAME;
  draft_mode: 'draft-only-local';
  external_execution: 'disabled';
  hosted_surface: CompanyHostedSurfaceConfig;
  disabled_actions: typeof COMPANY_FOLLOWUP_DISABLED_ACTIONS[number][];
  disabled_surfaces: typeof COMPANY_FOLLOWUP_DISABLED_SURFACES[number][];
  drafts: CompanyFollowUpDraft[];
  decision_context: CompanyFollowUpDecisionContext[];
  citations: CompanyFollowUpCitation[];
  draft_text: string;
}

interface WorkspaceContext {
  sourceId: string;
  limit: number;
  owner: string | null;
  project: string | null;
  includeClosed: boolean;
}

export async function draftCompanyFollowUp(
  engine: BrainEngine,
  input: CompanyFollowUpInput = {},
): Promise<CompanyFollowUpDraftResult> {
  const ctx = await resolveCompanyWorkspace(engine, input);
  const pages = await listFollowUpPages(engine, ctx.sourceId);
  const filtered = filterFollowUpPages(pages, ctx).slice(0, ctx.limit);
  const drafts = await Promise.all(filtered.map((page) => buildFollowUpDraft(engine, ctx.sourceId, page)));
  const decisionContext = await buildDecisionContext(engine, ctx.sourceId, drafts, ctx.project);
  const citations = dedupeCitations(drafts.flatMap((draft) => draft.citations));

  return {
    source_id: ctx.sourceId,
    trusted_workspace: true,
    schema_pack: COMPANY_SCHEMA_PACK_NAME,
    draft_mode: 'draft-only-local',
    external_execution: 'disabled',
    hosted_surface: buildCompanyHostedSurfaceConfig(),
    disabled_actions: [...COMPANY_FOLLOWUP_DISABLED_ACTIONS],
    disabled_surfaces: [...COMPANY_FOLLOWUP_DISABLED_SURFACES],
    drafts,
    decision_context: decisionContext,
    citations,
    draft_text: renderDraftText(drafts, decisionContext),
  };
}

async function resolveCompanyWorkspace(
  engine: BrainEngine,
  input: CompanyFollowUpInput,
): Promise<WorkspaceContext> {
  const brainMode = await engine.getConfig('brain.mode');
  const companyMode = await engine.getConfig('company.mode');
  if (brainMode !== COMPANY_MODE_KIND || companyMode !== COMPANY_TRUST_MODE) {
    throw new CompanyFollowUpError(
      'company_mode_required',
      'Company follow-up drafting requires a trusted-workspace company brain. Run `gbrain init --company` first.',
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
    throw new CompanyFollowUpError(
      'source_missing',
      `Company source "${sourceId}" is missing. Re-run \`gbrain init --company\` or create the source first.`,
    );
  }

  const limit = input.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new CompanyFollowUpError('bad_limit', 'Company follow-up --limit must be an integer from 1 to 100.');
  }

  return {
    sourceId,
    limit,
    owner: normalizeFilter(input.owner),
    project: normalizeFilter(input.project),
    includeClosed: input.includeClosed ?? false,
  };
}

async function listFollowUpPages(engine: BrainEngine, sourceId: string): Promise<Page[]> {
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT slug
       FROM pages
      WHERE source_id = $1
        AND deleted_at IS NULL
        AND type IN ('action', 'commitment')
      ORDER BY updated_at DESC, slug ASC
      LIMIT 500`,
    [sourceId],
  );
  const pages: Page[] = [];
  for (const row of rows) {
    const page = await engine.getPage(row.slug, { sourceId });
    if (page && (page.type === 'action' || page.type === 'commitment')) pages.push(page);
  }
  return pages;
}

function filterFollowUpPages(pages: Page[], ctx: WorkspaceContext): Page[] {
  return pages
    .filter((page) => {
      const status = stringOrNull(page.frontmatter.status);
      if (!ctx.includeClosed && isClosedStatus(status)) return false;
      if (ctx.owner && normalizeFilter(page.frontmatter.owner) !== ctx.owner) return false;
      const projects = arrayOfStrings(page.frontmatter.projects).map((p) => p.toLowerCase());
      if (ctx.project && !projects.includes(ctx.project)) return false;
      return true;
    })
    .sort((a, b) => {
      const dueA = dateOrMax(a.frontmatter.due_date);
      const dueB = dateOrMax(b.frontmatter.due_date);
      if (dueA !== dueB) return dueA.localeCompare(dueB);
      return b.updated_at.getTime() - a.updated_at.getTime() || a.slug.localeCompare(b.slug);
    });
}

async function buildFollowUpDraft(
  engine: BrainEngine,
  sourceId: string,
  page: Page,
): Promise<CompanyFollowUpDraft> {
  const summary = followUpText(page);
  const owner = stringOrNull(page.frontmatter.owner);
  const status = stringOrNull(page.frontmatter.status);
  const dueDate = stringOrNull(page.frontmatter.due_date);
  const projects = arrayOfStrings(page.frontmatter.projects);
  const citations = await buildCitations(engine, sourceId, page);
  const draft = [
    `Please share a status update for: ${summary}`,
    dueDate ? `Due date on record: ${dueDate}.` : null,
    projects.length > 0 ? `Project: ${projects.join(', ')}.` : null,
    `References: ${formatInlineCitations(citations)}.`,
  ].filter((line): line is string => Boolean(line)).join(' ');

  return {
    kind: page.type as 'action' | 'commitment',
    slug: page.slug,
    title: page.title,
    summary,
    owner,
    status,
    due_date: dueDate,
    projects,
    draft,
    citations,
  };
}

async function buildCitations(
  engine: BrainEngine,
  sourceId: string,
  page: Page,
): Promise<CompanyFollowUpCitation[]> {
  const citationSlugs = [
    page.slug,
    ...arrayOfStrings(page.frontmatter.derived_from),
    ...arrayOfStrings(page.frontmatter.evidence_refs),
    ...stringValues([
      page.frontmatter.source_page,
      page.frontmatter.source_meeting,
      page.frontmatter.source_doc,
      page.frontmatter.source_commitment,
      page.frontmatter.related_decision,
    ]),
  ];

  const citations: CompanyFollowUpCitation[] = [];
  for (const slug of dedupeStrings(citationSlugs)) {
    const cited = slug === page.slug ? page : await engine.getPage(slug, { sourceId });
    if (!cited) continue;
    citations.push({
      role: citationRole(cited, slug === page.slug),
      slug: cited.slug,
      title: cited.title,
      page_type: cited.type,
    });
  }
  return dedupeCitations(citations);
}

function citationRole(page: Page, self: boolean): CompanyFollowUpCitation['role'] {
  if (self) return 'follow_up';
  if (page.type === 'decision') return 'decision';
  if (page.type === 'evidence') return 'evidence';
  return 'source';
}

async function buildDecisionContext(
  engine: BrainEngine,
  sourceId: string,
  drafts: CompanyFollowUpDraft[],
  projectFilter: string | null,
): Promise<CompanyFollowUpDecisionContext[]> {
  const projects = new Set<string>();
  if (projectFilter) projects.add(projectFilter);
  for (const draft of drafts) {
    for (const project of draft.projects) projects.add(project.toLowerCase());
  }

  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT slug
       FROM pages
      WHERE source_id = $1
        AND deleted_at IS NULL
        AND type = 'decision'
      ORDER BY updated_at DESC, slug ASC
      LIMIT 100`,
    [sourceId],
  );
  const out: CompanyFollowUpDecisionContext[] = [];
  for (const row of rows) {
    const page = await engine.getPage(row.slug, { sourceId });
    if (!page) continue;
    const pageProjects = arrayOfStrings(page.frontmatter.projects);
    if (projects.size > 0 && !pageProjects.some((p) => projects.has(p.toLowerCase()))) continue;
    out.push({
      slug: page.slug,
      title: page.title,
      decision: decisionText(page),
      decision_date: dateForPage(page),
      projects: pageProjects,
    });
    if (out.length >= 10) break;
  }
  return out;
}

function renderDraftText(
  drafts: CompanyFollowUpDraft[],
  decisions: CompanyFollowUpDecisionContext[],
): string {
  const lines = [
    'Draft follow-up (not sent or executed)',
    'External execution is disabled in the trusted workspace pilot.',
    '',
  ];

  if (decisions.length > 0) {
    lines.push('Decision context:');
    for (const decision of decisions) {
      const date = decision.decision_date ? `${decision.decision_date}: ` : '';
      lines.push(`- ${date}${decision.decision} [decision: ${decision.slug}]`);
    }
    lines.push('');
  }

  if (drafts.length === 0) {
    lines.push('No open company commitments or action candidates matched the filters.');
    return lines.join('\n');
  }

  lines.push('Follow-up drafts:');
  for (const draft of drafts) {
    lines.push(`- To: ${draft.owner ?? 'Unassigned'}`);
    lines.push(`  Item: ${draft.summary}`);
    lines.push(`  Draft: ${draft.draft}`);
    lines.push(`  Citations: ${formatInlineCitations(draft.citations)}`);
  }
  return lines.join('\n');
}

function formatInlineCitations(citations: CompanyFollowUpCitation[]): string {
  const parts: string[] = [];
  for (const role of ['follow_up', 'decision', 'source', 'evidence'] as const) {
    const slugs = citations.filter((c) => c.role === role).map((c) => c.slug);
    if (slugs.length > 0) parts.push(`${role}: ${slugs.join(', ')}`);
  }
  return parts.length > 0 ? `[${parts.join('; ')}]` : '[source: unavailable]';
}

function followUpText(page: Page): string {
  const heading = page.type === 'commitment' ? 'Commitment' : 'Action';
  const section = headingSection(page.compiled_truth, heading);
  const candidate = firstMeaningfulLine(section ?? page.compiled_truth);
  if (candidate) return candidate;
  return page.title.replace(/^(Action|Commitment):\s*/i, '').trim() || page.title;
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

function stringValues(values: unknown[]): string[] {
  return values.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function normalizeFilter(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().toLowerCase() : null;
}

function isClosedStatus(status: string | null): boolean {
  return status !== null && /^(closed|complete|completed|done|cancelled|canceled)$/i.test(status);
}

function dateOrMax(value: unknown): string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '9999-12-31';
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function dedupeCitations(citations: CompanyFollowUpCitation[]): CompanyFollowUpCitation[] {
  const seen = new Set<string>();
  const out: CompanyFollowUpCitation[] = [];
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
