import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrainEngine } from './engine.ts';
import type { ImportResult } from './import-file.ts';
import { importFromContent } from './import-file.ts';
import { serializeMarkdown } from './markdown.ts';
import { slugifySegment } from './sync.ts';
import {
  COMPANY_SCHEMA_PACK_NAME,
  type CompanyObjectType,
} from './company-layout.ts';
import {
  COMPANY_MODE_KIND,
  COMPANY_PRIMARY_SOURCE_ID,
  COMPANY_TRUST_MODE,
} from './company-mode.ts';
import {
  assignCompanyObjectPolicyMetadata,
  loadCompanyPolicyStorageForObjectMetadata,
} from './company-object-policy.ts';
import type { CompanyPolicyStorage } from './company-policy.ts';

export const COMPANY_MANUAL_INGEST_KIND = 'company-manual';
export const COMPANY_INGEST_TEXT_EXTENSIONS = ['.txt', '.md', '.markdown'] as const;

export type CompanyIngestPageKind = 'meeting' | 'doc' | 'evidence';

export class CompanyIngestError extends Error {
  constructor(
    public code:
      | 'company_mode_required'
      | 'source_missing'
      | 'file_missing'
      | 'file_not_regular'
      | 'unsupported_file_type'
      | 'file_binary'
      | 'file_empty'
      | 'bad_date',
    message: string,
  ) {
    super(message);
    this.name = 'CompanyIngestError';
  }
}

export interface CompanyLinkedDocInput {
  path: string;
  title?: string;
  slug?: string;
}

export interface CompanyIngestBaseInput {
  sourceId?: string;
  createdBy?: string | null;
  noEmbed?: boolean;
  now?: Date;
}

export interface CompanyMeetingIngestInput extends CompanyIngestBaseInput {
  transcriptPath: string;
  title?: string;
  date?: string;
  slug?: string;
  attendees?: string[];
  projects?: string[];
  linkedDocs?: CompanyLinkedDocInput[];
}

export interface CompanyDocIngestInput extends CompanyIngestBaseInput {
  docPath: string;
  title?: string;
  date?: string;
  slug?: string;
  projects?: string[];
  linkedMeetingSlug?: string;
}

export interface CompanyIngestedPage {
  kind: CompanyIngestPageKind;
  slug: string;
  status: ImportResult['status'];
  chunks: number;
  source_uri: string;
  source_sha256: string;
}

export interface CompanyMeetingIngestResult {
  source_id: string;
  trusted_workspace: true;
  schema_pack: typeof COMPANY_SCHEMA_PACK_NAME;
  meeting: CompanyIngestedPage;
  evidence: CompanyIngestedPage[];
  docs: CompanyIngestedPage[];
}

export interface CompanyDocIngestResult {
  source_id: string;
  trusted_workspace: true;
  schema_pack: typeof COMPANY_SCHEMA_PACK_NAME;
  doc: CompanyIngestedPage;
  evidence: CompanyIngestedPage;
}

interface SourceFile {
  absPath: string;
  uri: string;
  filename: string;
  baseSlug: string;
  content: string;
  sha256: string;
  byteLength: number;
}

interface WorkspaceContext {
  sourceId: string;
  now: Date;
  capturedAt: string;
  createdBy: string | null;
  noEmbed: boolean;
  policyStorage: CompanyPolicyStorage | null;
}

export async function ingestCompanyMeeting(
  engine: BrainEngine,
  input: CompanyMeetingIngestInput,
): Promise<CompanyMeetingIngestResult> {
  const ctx = await resolveCompanyWorkspace(engine, input);
  const transcript = readSourceFile(input.transcriptPath, 'meeting transcript');
  const eventDate = normalizeDate(input.date, ctx.now);
  const title = input.title ?? titleFromContentOrFile(transcript, 'Meeting');
  const meetingSlug = input.slug ?? `meetings/${eventDate}-${boundedSlugSegment(title, transcript.baseSlug)}`;
  const evidenceSlug = evidenceSlugFor(eventDate, 'transcript', title, transcript.baseSlug);

  const linkedDocResults: CompanyDocIngestResult[] = [];
  for (const doc of input.linkedDocs ?? []) {
    const docResult = await ingestCompanyDocInternal(engine, {
      ...doc,
      docPath: doc.path,
      date: eventDate,
      projects: input.projects,
      linkedMeetingSlug: meetingSlug,
    }, ctx);
    linkedDocResults.push(docResult);
  }
  const linkedDocs = linkedDocResults.map((result) => result.doc);

  const evidenceContent = buildEvidenceMarkdown({
    slug: evidenceSlug,
    title: `Transcript evidence: ${title}`,
    evidenceType: 'transcript',
    sourceFile: transcript,
    capturedAt: ctx.capturedAt,
    supports: [meetingSlug],
    ctx,
  });

  const meetingEvidence = await importCompanyPage(engine, {
    sourceId: ctx.sourceId,
    slug: evidenceSlug,
    content: evidenceContent,
    noEmbed: ctx.noEmbed,
    sourceUri: transcript.uri,
    sourceKind: COMPANY_MANUAL_INGEST_KIND,
    ingestedVia: 'company-manual:evidence',
    sourceSha256: transcript.sha256,
    kind: 'evidence',
  });

  const meetingContent = buildMeetingMarkdown({
    slug: meetingSlug,
    title,
    eventDate,
    transcript,
    attendees: input.attendees ?? [],
    projects: input.projects ?? [],
    linkedDocSlugs: linkedDocs.map((d) => d.slug),
    evidenceRefs: [meetingEvidence.slug],
    ctx,
    capturedAt: ctx.capturedAt,
  });

  const meeting = await importCompanyPage(engine, {
    sourceId: ctx.sourceId,
    slug: meetingSlug,
    content: meetingContent,
    noEmbed: ctx.noEmbed,
    sourceUri: transcript.uri,
    sourceKind: COMPANY_MANUAL_INGEST_KIND,
    ingestedVia: 'company-manual:meeting-transcript',
    sourceSha256: transcript.sha256,
    kind: 'meeting',
  });

  return {
    source_id: ctx.sourceId,
    trusted_workspace: true,
    schema_pack: COMPANY_SCHEMA_PACK_NAME,
    meeting,
    evidence: [meetingEvidence, ...linkedDocResults.map((result) => result.evidence)],
    docs: linkedDocs,
  };
}

export async function ingestCompanyDoc(
  engine: BrainEngine,
  input: CompanyDocIngestInput,
): Promise<CompanyDocIngestResult> {
  const ctx = await resolveCompanyWorkspace(engine, input);
  return ingestCompanyDocInternal(engine, input, ctx);
}

async function ingestCompanyDocInternal(
  engine: BrainEngine,
  input: CompanyDocIngestInput,
  ctx: WorkspaceContext,
): Promise<CompanyDocIngestResult> {
  const file = readSourceFile(input.docPath, 'linked document');
  const date = normalizeDate(input.date, ctx.now);
  const title = input.title ?? titleFromContentOrFile(file, 'Document');
  const docSlug = input.slug ?? `docs/${boundedSlugSegment(title, file.baseSlug)}`;
  const evidenceSlug = evidenceSlugFor(date, 'doc', title, file.baseSlug);

  const evidenceContent = buildEvidenceMarkdown({
    slug: evidenceSlug,
    title: `Document evidence: ${title}`,
    evidenceType: 'linked_doc',
    sourceFile: file,
    capturedAt: ctx.capturedAt,
    supports: [docSlug, ...(input.linkedMeetingSlug ? [input.linkedMeetingSlug] : [])],
    ctx,
  });
  const evidence = await importCompanyPage(engine, {
    sourceId: ctx.sourceId,
    slug: evidenceSlug,
    content: evidenceContent,
    noEmbed: ctx.noEmbed,
    sourceUri: file.uri,
    sourceKind: COMPANY_MANUAL_INGEST_KIND,
    ingestedVia: 'company-manual:evidence',
    sourceSha256: file.sha256,
    kind: 'evidence',
  });

  const docContent = buildDocMarkdown({
    slug: docSlug,
    title,
    file,
    projects: input.projects ?? [],
    linkedMeetingSlug: input.linkedMeetingSlug,
    evidenceRefs: [evidence.slug],
    ctx,
    capturedAt: ctx.capturedAt,
  });
  const doc = await importCompanyPage(engine, {
    sourceId: ctx.sourceId,
    slug: docSlug,
    content: docContent,
    noEmbed: ctx.noEmbed,
    sourceUri: file.uri,
    sourceKind: COMPANY_MANUAL_INGEST_KIND,
    ingestedVia: 'company-manual:linked-doc',
    sourceSha256: file.sha256,
    kind: 'doc',
  });

  return {
    source_id: ctx.sourceId,
    trusted_workspace: true,
    schema_pack: COMPANY_SCHEMA_PACK_NAME,
    doc,
    evidence,
  };
}

async function resolveCompanyWorkspace(
  engine: BrainEngine,
  input: CompanyIngestBaseInput,
): Promise<WorkspaceContext> {
  const brainMode = await engine.getConfig('brain.mode');
  const companyMode = await engine.getConfig('company.mode');
  if (brainMode !== COMPANY_MODE_KIND || companyMode !== COMPANY_TRUST_MODE) {
    throw new CompanyIngestError(
      'company_mode_required',
      'Company ingestion requires a trusted-workspace company brain. Run `gbrain init --company` first.',
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
    throw new CompanyIngestError(
      'source_missing',
      `Company source "${sourceId}" is missing. Re-run \`gbrain init --company\` or create the source first.`,
    );
  }

  const now = input.now ?? new Date();
  return {
    sourceId,
    now,
    capturedAt: now.toISOString(),
    createdBy: input.createdBy ?? null,
    noEmbed: input.noEmbed ?? false,
    policyStorage: await loadCompanyPolicyStorageForObjectMetadata(engine),
  };
}

function readSourceFile(path: string, label: string): SourceFile {
  const absPath = resolve(path);
  if (!existsSync(absPath)) {
    throw new CompanyIngestError('file_missing', `${label} file not found: ${path}`);
  }
  const lst = lstatSync(absPath);
  if (lst.isSymbolicLink() || !statSync(absPath).isFile()) {
    throw new CompanyIngestError('file_not_regular', `${label} must be a regular file: ${path}`);
  }
  const extension = extname(absPath).toLowerCase();
  if (!COMPANY_INGEST_TEXT_EXTENSIONS.includes(extension as typeof COMPANY_INGEST_TEXT_EXTENSIONS[number])) {
    throw new CompanyIngestError(
      'unsupported_file_type',
      `${label} must be a local text/markdown file (${COMPANY_INGEST_TEXT_EXTENSIONS.join(', ')}): ${path}`,
    );
  }
  const buf = readFileSync(absPath);
  const nul = buf.indexOf(0);
  if (nul !== -1) {
    throw new CompanyIngestError(
      'file_binary',
      `${label} appears to be binary (null byte at offset ${nul}); Stage 1C accepts local text files only.`,
    );
  }
  const content = buf.toString('utf8');
  if (content.trim().length === 0) {
    throw new CompanyIngestError('file_empty', `${label} is empty: ${path}`);
  }
  const filename = basename(absPath);
  const base = filename.slice(0, filename.length - extname(filename).length) || filename;
  return {
    absPath,
    uri: pathToFileURL(absPath).toString(),
    filename,
    baseSlug: boundedSlugSegment(base, 'source'),
    content,
    sha256: createHash('sha256').update(buf).digest('hex'),
    byteLength: buf.length,
  };
}

function normalizeDate(date: string | undefined, now: Date): string {
  if (!date) {
    return now.toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new CompanyIngestError('bad_date', `Expected --date YYYY-MM-DD, got "${date}".`);
  }
  return date;
}

function titleFromContentOrFile(file: SourceFile, fallback: string): string {
  const heading = file.content.split(/\r?\n/).find((line) => /^#{1,2}\s+\S/.test(line.trim()));
  if (heading) return heading.replace(/^#{1,2}\s+/, '').trim();
  const stem = file.filename.slice(0, file.filename.length - extname(file.filename).length);
  return stem.replace(/[-_]+/g, ' ').trim() || fallback;
}

function boundedSlugSegment(raw: string, fallback: string): string {
  const segment = slugifySegment(raw).slice(0, 80).replace(/-+$/g, '');
  return segment || slugifySegment(fallback).slice(0, 80) || 'untitled';
}

function evidenceSlugFor(date: string, kind: string, title: string, fallback: string): string {
  return `evidence/${date}-${kind}-${boundedSlugSegment(title, fallback)}`;
}

function baseFrontmatter(
  ctx: WorkspaceContext,
  objectType: CompanyObjectType,
  slug: string,
  derivedFrom: string[],
  evidenceRefs: string[],
): Record<string, unknown> {
  return assignCompanyObjectPolicyMetadata({}, {
    objectType,
    slug,
    storage: ctx.policyStorage,
    createdBy: ctx.createdBy,
    derivedFrom,
    evidenceRefs,
  });
}

function markdownLinkList(slugs: string[]): string {
  if (slugs.length === 0) return '- None\n';
  return slugs.map((slug) => `- [[${slug}]]`).join('\n') + '\n';
}

function buildMeetingMarkdown(input: {
  slug: string;
  title: string;
  eventDate: string;
  transcript: SourceFile;
  attendees: string[];
  projects: string[];
  linkedDocSlugs: string[];
  evidenceRefs: string[];
  ctx: WorkspaceContext;
  capturedAt: string;
}): string {
  const frontmatter = {
    ...baseFrontmatter(input.ctx, 'meeting', input.slug, input.evidenceRefs, input.evidenceRefs),
    event_date: input.eventDate,
    attendees: input.attendees,
    projects: input.projects,
    linked_docs: input.linkedDocSlugs,
    source_ref: input.transcript.uri,
    source_file: input.transcript.absPath,
    source_sha256: input.transcript.sha256,
    source_bytes: input.transcript.byteLength,
    captured_at: input.capturedAt,
    ingestion_stage: 'stage-1c-manual',
  };
  const body = [
    '## Summary',
    '',
    'Manual trusted-workspace meeting transcript ingestion. Extraction of decisions, commitments, owners, and follow-up actions is deferred to Stage 1D.',
    '',
    '## Linked Docs',
    '',
    markdownLinkList(input.linkedDocSlugs).trimEnd(),
    '',
    '## Evidence',
    '',
    markdownLinkList(input.evidenceRefs).trimEnd(),
    '',
    '## Transcript',
    '',
    input.transcript.content.trim(),
  ].join('\n');
  return serializeMarkdown(frontmatter, body, '', {
    type: 'meeting',
    title: input.title,
    tags: ['company', 'meeting', 'trusted-workspace'],
  });
}

function buildDocMarkdown(input: {
  slug: string;
  title: string;
  file: SourceFile;
  projects: string[];
  linkedMeetingSlug?: string;
  evidenceRefs: string[];
  ctx: WorkspaceContext;
  capturedAt: string;
}): string {
  const frontmatter = {
    ...baseFrontmatter(input.ctx, 'doc', input.slug, input.evidenceRefs, input.evidenceRefs),
    doc_status: 'captured',
    source_ref: input.file.uri,
    source_file: input.file.absPath,
    source_sha256: input.file.sha256,
    source_bytes: input.file.byteLength,
    owners: [],
    projects: input.projects,
    linked_meetings: input.linkedMeetingSlug ? [input.linkedMeetingSlug] : [],
    captured_at: input.capturedAt,
    ingestion_stage: 'stage-1c-manual',
  };
  const body = [
    '## Summary',
    '',
    'Manual trusted-workspace linked document ingestion. Extraction and citation synthesis are deferred to later Stage 1 steps.',
    '',
    '## Linked Meetings',
    '',
    markdownLinkList(input.linkedMeetingSlug ? [input.linkedMeetingSlug] : []).trimEnd(),
    '',
    '## Evidence',
    '',
    markdownLinkList(input.evidenceRefs).trimEnd(),
    '',
    '## Document',
    '',
    input.file.content.trim(),
  ].join('\n');
  return serializeMarkdown(frontmatter, body, '', {
    type: 'doc',
    title: input.title,
    tags: ['company', 'doc', 'trusted-workspace'],
  });
}

function buildEvidenceMarkdown(input: {
  slug: string;
  title: string;
  evidenceType: 'transcript' | 'linked_doc';
  sourceFile: SourceFile;
  capturedAt: string;
  supports: string[];
  ctx: WorkspaceContext;
}): string {
  const frontmatter = {
    ...baseFrontmatter(input.ctx, 'evidence', input.slug, [], []),
    evidence_type: input.evidenceType,
    source_ref: input.sourceFile.uri,
    source_file: input.sourceFile.absPath,
    source_sha256: input.sourceFile.sha256,
    source_bytes: input.sourceFile.byteLength,
    captured_at: input.capturedAt,
    supports: input.supports,
    ingestion_stage: 'stage-1c-manual',
  };
  const body = [
    '## Evidence',
    '',
    `Source file: ${input.sourceFile.uri}`,
    `SHA-256: ${input.sourceFile.sha256}`,
    '',
    '## Supports',
    '',
    markdownLinkList(input.supports).trimEnd(),
    '',
    '## Content',
    '',
    input.sourceFile.content.trim(),
  ].join('\n');
  return serializeMarkdown(frontmatter, body, '', {
    type: 'evidence',
    title: input.title,
    tags: ['company', 'evidence', 'trusted-workspace'],
  });
}

async function importCompanyPage(
  engine: BrainEngine,
  input: {
    sourceId: string;
    slug: string;
    content: string;
    noEmbed: boolean;
    sourceUri: string;
    sourceKind: string;
    ingestedVia: string;
    sourceSha256: string;
    kind: CompanyIngestPageKind;
  },
): Promise<CompanyIngestedPage> {
  const result = await importFromContent(engine, input.slug, input.content, {
    noEmbed: input.noEmbed,
    sourceId: input.sourceId,
    source_kind: input.sourceKind,
    source_uri: input.sourceUri,
    ingested_via: input.ingestedVia,
  });
  return {
    kind: input.kind,
    slug: result.slug,
    status: result.status,
    chunks: result.chunks,
    source_uri: input.sourceUri,
    source_sha256: input.sourceSha256,
  };
}
