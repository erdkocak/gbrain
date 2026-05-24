import type { BrainEngine } from './engine.ts';
import type { ImportResult } from './import-file.ts';
import { importFromContent } from './import-file.ts';
import { serializeMarkdown } from './markdown.ts';
import { slugifySegment } from './sync.ts';
import type { Page } from './types.ts';
import {
  COMPANY_SCHEMA_PACK_NAME,
} from './company-layout.ts';
import {
  COMPANY_MODE_KIND,
  COMPANY_PRIMARY_SOURCE_ID,
  COMPANY_TRUST_MODE,
} from './company-mode.ts';
import {
  assignCompanyObjectPolicyMetadata,
  companyVisibilityPolicySetFromPage,
  loadCompanyPolicyStorageForObjectMetadata,
} from './company-object-policy.ts';
import type { CompanyPolicyStorage } from './company-policy.ts';

export const COMPANY_EXTRACTION_KIND = 'company-extraction';

export type CompanyExtractionPageKind = 'decision' | 'commitment' | 'action';

export class CompanyExtractError extends Error {
  constructor(
    public code:
      | 'company_mode_required'
      | 'source_missing'
      | 'bad_limit',
    message: string,
  ) {
    super(message);
    this.name = 'CompanyExtractError';
  }
}

export interface CompanyExtractInput {
  sourceId?: string;
  slugs?: string[];
  createdBy?: string | null;
  noEmbed?: boolean;
  now?: Date;
  limit?: number;
}

export interface CompanyExtractedPage {
  kind: CompanyExtractionPageKind;
  slug: string;
  status: ImportResult['status'];
  chunks: number;
  derived_from: string[];
  evidence_refs: string[];
  owner: string | null;
}

export interface CompanyExtractionSkippedPage {
  slug: string;
  reason: string;
}

export interface CompanyExtractionResult {
  source_id: string;
  trusted_workspace: true;
  schema_pack: typeof COMPANY_SCHEMA_PACK_NAME;
  inputs: string[];
  decisions: CompanyExtractedPage[];
  commitments: CompanyExtractedPage[];
  actions: CompanyExtractedPage[];
  skipped: CompanyExtractionSkippedPage[];
}

interface WorkspaceContext {
  sourceId: string;
  capturedAt: string;
  createdBy: string | null;
  noEmbed: boolean;
  limit: number;
  policyStorage: CompanyPolicyStorage | null;
}

interface SourceUnit {
  text: string;
  quote: string;
  speaker: string | null;
  index: number;
}

interface Artifact {
  kind: CompanyExtractionPageKind;
  text: string;
  quote: string;
  owner: string | null;
  source: Page;
  date: string;
  projects: string[];
  evidenceRefs: string[];
  index: number;
}

export async function extractCompanyMemory(
  engine: BrainEngine,
  input: CompanyExtractInput = {},
): Promise<CompanyExtractionResult> {
  const ctx = await resolveCompanyWorkspace(engine, input);
  const targetSlugs = input.slugs && input.slugs.length > 0
    ? dedupe(input.slugs)
    : await listCompanyExtractionTargets(engine, ctx.sourceId, ctx.limit);

  const result: CompanyExtractionResult = {
    source_id: ctx.sourceId,
    trusted_workspace: true,
    schema_pack: COMPANY_SCHEMA_PACK_NAME,
    inputs: [],
    decisions: [],
    commitments: [],
    actions: [],
    skipped: [],
  };

  const usedSlugs = new Set<string>();
  for (const slug of targetSlugs) {
    const page = await engine.getPage(slug, { sourceId: ctx.sourceId });
    if (!page) {
      result.skipped.push({ slug, reason: 'not_found' });
      continue;
    }
    if (page.type !== 'meeting' && page.type !== 'doc') {
      result.skipped.push({ slug, reason: `unsupported_type:${page.type}` });
      continue;
    }
    result.inputs.push(slug);

    const artifacts = extractArtifactsFromPage(page);
    if (artifacts.length === 0) {
      result.skipped.push({ slug, reason: 'no_extraction_patterns' });
      continue;
    }

    for (const artifact of artifacts) {
      const imported = await importArtifact(engine, ctx, artifact, usedSlugs);
      if (artifact.kind === 'decision') result.decisions.push(imported);
      if (artifact.kind === 'commitment') result.commitments.push(imported);
      if (artifact.kind === 'action') result.actions.push(imported);
    }
  }

  return result;
}

async function resolveCompanyWorkspace(
  engine: BrainEngine,
  input: CompanyExtractInput,
): Promise<WorkspaceContext> {
  const brainMode = await engine.getConfig('brain.mode');
  const companyMode = await engine.getConfig('company.mode');
  if (brainMode !== COMPANY_MODE_KIND || companyMode !== COMPANY_TRUST_MODE) {
    throw new CompanyExtractError(
      'company_mode_required',
      'Company extraction requires a trusted-workspace company brain. Run `gbrain init --company` first.',
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
    throw new CompanyExtractError(
      'source_missing',
      `Company source "${sourceId}" is missing. Re-run \`gbrain init --company\` or create the source first.`,
    );
  }

  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new CompanyExtractError('bad_limit', 'Company extraction --limit must be an integer from 1 to 1000.');
  }

  const now = input.now ?? new Date();
  return {
    sourceId,
    capturedAt: now.toISOString(),
    createdBy: input.createdBy ?? null,
    noEmbed: input.noEmbed ?? false,
    limit,
    policyStorage: await loadCompanyPolicyStorageForObjectMetadata(engine),
  };
}

async function listCompanyExtractionTargets(
  engine: BrainEngine,
  sourceId: string,
  limit: number,
): Promise<string[]> {
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT slug
       FROM pages
      WHERE source_id = $1
        AND deleted_at IS NULL
        AND type IN ('meeting', 'doc')
      ORDER BY updated_at ASC, slug ASC
      LIMIT $2`,
    [sourceId, limit],
  );
  return rows.map((row) => row.slug);
}

function extractArtifactsFromPage(page: Page): Artifact[] {
  const text = sourceTextForPage(page);
  const units = sourceUnits(text);
  const date = dateForPage(page);
  const projects = arrayOfStrings(page.frontmatter.projects);
  const evidenceRefs = arrayOfStrings(page.frontmatter.evidence_refs);
  const artifacts: Artifact[] = [];
  const seen = new Set<string>();

  for (const unit of units) {
    const decision = decisionFromUnit(unit);
    if (decision) {
      pushArtifact(artifacts, seen, {
        kind: 'decision',
        text: decision.text,
        quote: unit.quote,
        owner: decision.owner,
        source: page,
        date,
        projects,
        evidenceRefs,
        index: unit.index,
      });
    }

    const commitment = commitmentFromUnit(unit);
    if (commitment) {
      pushArtifact(artifacts, seen, {
        kind: 'commitment',
        text: commitment.text,
        quote: unit.quote,
        owner: commitment.owner,
        source: page,
        date,
        projects,
        evidenceRefs,
        index: unit.index,
      });
    }

    const action = actionFromUnit(unit, commitment?.owner ?? null);
    if (action) {
      pushArtifact(artifacts, seen, {
        kind: 'action',
        text: action.text,
        quote: unit.quote,
        owner: action.owner,
        source: page,
        date,
        projects,
        evidenceRefs,
        index: unit.index,
      });
    }
  }

  return artifacts;
}

function pushArtifact(artifacts: Artifact[], seen: Set<string>, artifact: Artifact): void {
  const key = `${artifact.kind}:${artifact.owner ?? ''}:${normalizeKey(artifact.text)}`;
  if (seen.has(key)) return;
  seen.add(key);
  artifacts.push(artifact);
}

function sourceTextForPage(page: Page): string {
  if (page.type === 'meeting') {
    return headingSection(page.compiled_truth, 'Transcript') ?? page.compiled_truth;
  }
  if (page.type === 'doc') {
    return headingSection(page.compiled_truth, 'Document') ?? page.compiled_truth;
  }
  return page.compiled_truth;
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

function sourceUnits(text: string): SourceUnit[] {
  const units: SourceUnit[] = [];
  let index = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const cleaned = rawLine
      .replace(/^\s*[-*]\s+/, '')
      .replace(/^\s*\d+[.)]\s+/, '')
      .trim();
    if (!cleaned) continue;
    for (const piece of splitIntoSentences(cleaned)) {
      const parsed = speakerAndText(piece);
      units.push({
        text: parsed.text,
        quote: piece.trim(),
        speaker: parsed.speaker,
        index: index++,
      });
    }
  }
  return units;
}

function splitIntoSentences(line: string): string[] {
  if (line.length <= 240) return [line];
  return line
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function speakerAndText(line: string): { speaker: string | null; text: string } {
  const m = line.match(/^([^:]{1,80}):\s+(.+)$/);
  if (!m) return { speaker: null, text: line.trim() };
  const label = m[1]!.trim();
  if (/^(decision|action|todo|follow[- ]?up|commitment|owner|note)$/i.test(label)) {
    return { speaker: null, text: line.trim() };
  }
  return { speaker: label, text: m[2]!.trim() };
}

function decisionFromUnit(unit: SourceUnit): { text: string; owner: string | null } | null {
  const text = unit.text.trim();
  const labeled = text.match(/^(?:decision|decided|approved)\s*:\s*(.+)$/i);
  if (labeled) return cleanArtifact(labeled[1]!, null);

  if (/\bwe\s+(?:agreed|decided|approved|chose|settled)\b/i.test(text)
    || /\bagreed\s+to\b/i.test(text)
    || /\bdecision\s+is\b/i.test(text)) {
    return cleanArtifact(text, null);
  }
  return null;
}

function commitmentFromUnit(unit: SourceUnit): { text: string; owner: string | null } | null {
  const text = unit.text.trim();
  const labeled = text.match(/^commitment\s*:\s*(.+)$/i);
  if (labeled) {
    const owner = ownerFromText(labeled[1]!) ?? unit.speaker;
    return cleanArtifact(labeled[1]!, owner);
  }

  if (unit.speaker && /\bI\s+(?:will|'ll|am going to|can)\b/i.test(text)) {
    return cleanArtifact(text, unit.speaker);
  }

  const owned = text.match(/^([A-Za-z][A-Za-z0-9._-]*(?:\s+[A-Za-z][A-Za-z0-9._-]*){0,3})\s+(?:will|owns|committed to)\s+(.+)$/i);
  if (owned && !/^(we|team|everyone)$/i.test(owned[1]!)) {
    return cleanArtifact(text, owned[1]!.trim());
  }

  const ownerInline = ownerFromText(text);
  if (ownerInline && /\b(?:will|commit|committed|owns|deliver|send|ship|finish)\b/i.test(text)) {
    return cleanArtifact(text, ownerInline);
  }

  return null;
}

function actionFromUnit(unit: SourceUnit, fallbackOwner: string | null): { text: string; owner: string | null } | null {
  const text = unit.text.trim();
  const explicit = text.match(/^(?:action|todo|follow[- ]?up)\s*:\s*(.+)$/i);
  if (explicit) {
    const actionText = explicit[1]!.trim();
    return cleanArtifact(actionText, ownerFromText(actionText) ?? unit.speaker ?? fallbackOwner);
  }
  if (/\bfollow[- ]?up\b/i.test(text) && /\b(?:will|send|share|schedule|draft|prepare|update|create)\b/i.test(text)) {
    return cleanArtifact(text, fallbackOwner ?? unit.speaker ?? ownerFromText(text));
  }
  return null;
}

function ownerFromText(text: string): string | null {
  const owner = text.match(/\bowner\s*:\s*([A-Za-z][A-Za-z0-9._-]*(?:\s+[A-Za-z][A-Za-z0-9._-]*){0,2})(?=\s+(?:to|will|should|must|deliver|send|ship|finish|update|draft|prepare|create|schedule|review)\b|[.;,]|$)/i);
  if (owner) return owner[1]!.trim();
  const subject = text.match(/^([A-Za-z][A-Za-z0-9._-]*(?:\s+[A-Za-z][A-Za-z0-9._-]*){0,3})\s+(?:will|to|owns|committed to)\b/i);
  if (!subject || /^(we|team|everyone)$/i.test(subject[1]!)) return null;
  return subject[1]!.trim();
}

function cleanArtifact(raw: string, owner: string | null): { text: string; owner: string | null } | null {
  const text = raw.replace(/\s+/g, ' ').replace(/[ \t]+[.;:]$/g, '').trim();
  if (text.length < 8) return null;
  return { text, owner: owner ? owner.replace(/\s+/g, ' ').trim() : null };
}

async function importArtifact(
  engine: BrainEngine,
  ctx: WorkspaceContext,
  artifact: Artifact,
  usedSlugs: Set<string>,
): Promise<CompanyExtractedPage> {
  const slug = uniqueSlug(slugForArtifact(artifact), usedSlugs);
  const content = buildArtifactMarkdown(artifact, ctx, slug);
  const result = await importFromContent(engine, slug, content, {
    noEmbed: ctx.noEmbed,
    sourceId: ctx.sourceId,
    source_kind: COMPANY_EXTRACTION_KIND,
    source_uri: `gbrain://company/${ctx.sourceId}/${artifact.source.slug}`,
    ingested_via: `company-extract:${artifact.kind}`,
  });
  return {
    kind: artifact.kind,
    slug: result.slug,
    status: result.status,
    chunks: result.chunks,
    derived_from: [artifact.source.slug],
    evidence_refs: artifact.evidenceRefs,
    owner: artifact.owner,
  };
}

function buildArtifactMarkdown(artifact: Artifact, ctx: WorkspaceContext, slug: string): string {
  const frontmatter = assignCompanyObjectPolicyMetadata({
    derived_from: [artifact.source.slug],
    evidence_refs: artifact.evidenceRefs,
    source_page: artifact.source.slug,
    source_type: artifact.source.type,
    source_quote: artifact.quote,
    projects: artifact.projects,
    captured_at: ctx.capturedAt,
    extraction_kind: COMPANY_EXTRACTION_KIND,
    extraction_method: 'deterministic-local-patterns',
  }, {
    objectType: artifact.kind,
    slug,
    storage: ctx.policyStorage,
    createdBy: ctx.createdBy ?? stringOrNull(artifact.source.frontmatter.created_by),
    derivedFrom: [artifact.source.slug],
    evidenceRefs: artifact.evidenceRefs,
    sourceVisibilityPolicyIds: [companyVisibilityPolicySetFromPage(artifact.source)],
  });

  if (artifact.kind === 'decision') {
    return serializeMarkdown({
      ...frontmatter,
      decision_date: artifact.date,
      status: 'accepted',
      owner: artifact.owner,
      deciders: [],
    }, decisionBody(artifact), '', {
      type: 'decision',
      title: titleForArtifact('Decision', artifact),
      tags: ['company', 'decision', 'trusted-workspace', 'derived'],
    });
  }

  if (artifact.kind === 'commitment') {
    return serializeMarkdown({
      ...frontmatter,
      owner: artifact.owner,
      due_date: null,
      status: 'open',
      related_decision: null,
      source_meeting: artifact.source.type === 'meeting' ? artifact.source.slug : null,
      source_doc: artifact.source.type === 'doc' ? artifact.source.slug : null,
    }, commitmentBody(artifact), '', {
      type: 'commitment',
      title: titleForArtifact('Commitment', artifact),
      tags: ['company', 'commitment', 'trusted-workspace', 'derived'],
    });
  }

  return serializeMarkdown({
    ...frontmatter,
    owner: artifact.owner,
    due_date: null,
    status: 'open',
    source_meeting: artifact.source.type === 'meeting' ? artifact.source.slug : null,
    source_doc: artifact.source.type === 'doc' ? artifact.source.slug : null,
    source_commitment: null,
  }, actionBody(artifact), '', {
    type: 'action',
    title: titleForArtifact('Action', artifact),
    tags: ['company', 'action', 'trusted-workspace', 'derived'],
  });
}

function decisionBody(artifact: Artifact): string {
  return [
    '## Decision',
    '',
    artifact.text,
    '',
    '## Context',
    '',
    `Derived from [[${artifact.source.slug}]] in the trusted company workspace.`,
    '',
    '## Evidence',
    '',
    evidenceMarkdown(artifact),
    '',
    '## Follow Up',
    '',
    'Local extraction records candidates only; external execution and policy enforcement are deferred.',
  ].join('\n');
}

function commitmentBody(artifact: Artifact): string {
  return [
    '## Commitment',
    '',
    artifact.text,
    '',
    '## Evidence',
    '',
    evidenceMarkdown(artifact),
    '',
    '## Updates',
    '',
    'Open trusted-workspace commitment extracted locally.',
  ].join('\n');
}

function actionBody(artifact: Artifact): string {
  return [
    '## Action',
    '',
    artifact.text,
    '',
    '## Context',
    '',
    `Candidate follow-up from [[${artifact.source.slug}]]. Drafting and external execution are deferred.`,
    '',
    '## Evidence',
    '',
    evidenceMarkdown(artifact),
  ].join('\n');
}

function evidenceMarkdown(artifact: Artifact): string {
  const refs = artifact.evidenceRefs.length === 0
    ? '- None'
    : artifact.evidenceRefs.map((ref) => `- [[${ref}]]`).join('\n');
  return [
    `- Source: [[${artifact.source.slug}]]`,
    refs,
    '',
    `> ${artifact.quote}`,
  ].join('\n');
}

function slugForArtifact(artifact: Artifact): string {
  const source = boundedSlugSegment(sourceTailForSlug(artifact.source.slug), 'source', 48);
  const text = boundedSlugSegment(artifact.text, artifact.kind, 72);
  if (artifact.kind === 'decision') return `decisions/${artifact.date}-${source}-${text}`;
  const owner = boundedSlugSegment(artifact.owner ?? 'unassigned', 'unassigned', 40);
  if (artifact.kind === 'commitment') return `commitments/${artifact.date}-${source}-${owner}-${text}`;
  return `actions/${artifact.date}-${source}-${owner}-${text}`;
}

function sourceTailForSlug(slug: string): string {
  const tail = slug.split('/').pop() ?? slug;
  return tail.replace(/^\d{4}-\d{2}-\d{2}-/, '') || tail;
}

function uniqueSlug(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

function titleForArtifact(prefix: string, artifact: Artifact): string {
  const owner = artifact.owner ? `${artifact.owner}: ` : '';
  return `${prefix}: ${owner}${artifact.text}`.slice(0, 120);
}

function dateForPage(page: Page): string {
  const candidates = [
    page.frontmatter.event_date,
    page.frontmatter.decision_date,
    page.frontmatter.date,
    typeof page.frontmatter.captured_at === 'string' ? page.frontmatter.captured_at.slice(0, 10) : null,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  }
  return page.updated_at.toISOString().slice(0, 10);
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function boundedSlugSegment(raw: string, fallback: string, max = 80): string {
  const segment = slugifySegment(raw).slice(0, max).replace(/[-.]+$/g, '');
  return segment || slugifySegment(fallback).slice(0, max) || 'untitled';
}

function normalizeKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
