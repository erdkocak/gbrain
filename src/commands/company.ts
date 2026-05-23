import type { BrainEngine } from '../core/engine.ts';
import {
  CompanyIngestError,
  ingestCompanyDoc,
  ingestCompanyMeeting,
  type CompanyDocIngestInput,
  type CompanyDocIngestResult,
  type CompanyLinkedDocInput,
  type CompanyMeetingIngestInput,
  type CompanyMeetingIngestResult,
} from '../core/company-ingest.ts';
import {
  CompanyExtractError,
  extractCompanyMemory,
  type CompanyExtractInput,
  type CompanyExtractionResult,
} from '../core/company-extract.ts';
import {
  answerCompanyQuestion,
  CompanyRetrieveError,
  type CompanyRetrieveInput,
  type CompanyRetrieveResult,
} from '../core/company-retrieve.ts';
import { isAvailable } from '../core/ai/gateway.ts';

const HELP = `Usage:
  gbrain company ingest meeting <transcript.txt|.md|.markdown> [options]
  gbrain company ingest doc <document.txt|.md|.markdown> [options]
  gbrain company extract all [options]
  gbrain company extract <meeting-or-doc-slug> [more slugs...] [options]
  gbrain company query <question> [options]
  gbrain company decisions [question terms] [options]

Stage 1C-1E local/manual company memory for a trusted workspace pilot.
Ingest writes meeting, doc, and evidence pages with file provenance. Extract
derives decisions, commitments, and follow-up action candidates from trusted
meeting/doc pages. Query answers from company layout pages with citations to
meetings, docs, and evidence. These commands do not start live integrations,
cron, webhooks, background connectors, hosted write access, query cache,
hot-memory, code-intelligence reads, analytics reads, or dream-cycle outputs.

Meeting options:
  --title TITLE          Meeting title
  --date YYYY-MM-DD      Meeting date (default: today)
  --slug SLUG            Override meetings/YYYY-MM-DD-title slug
  --attendee NAME        Repeatable; comma-separated values also accepted
  --project NAME         Repeatable; comma-separated values also accepted
  --doc PATH             Repeatable linked local text/markdown document

Doc options:
  --title TITLE          Document title
  --date YYYY-MM-DD      Capture/evidence date (default: today)
  --slug SLUG            Override docs/title slug
  --project NAME         Repeatable; comma-separated values also accepted

Extract options:
  --limit N              Max meeting/doc pages for "extract all" (1-1000, default: 100)

Query options:
  --project NAME         Restrict retrieval to decisions tagged with project
  --limit N              Max decision results (1-100, default: 10)

Common options:
  --source-id ID         Override company primary source (default: company)
  --json                 JSON receipt/result

Ingest/extract options:
  --created-by ID        Reserved provenance placeholder, not an ACL identity
  --no-embed             Skip embeddings
  --help, -h             Show this help
`;

interface ParsedBase {
  json: boolean;
  noEmbed: boolean | undefined;
  sourceId: string | undefined;
  createdBy: string | undefined;
}

type Parsed =
  | ({ kind: 'meeting'; input: CompanyMeetingIngestInput; json: boolean })
  | ({ kind: 'doc'; input: CompanyDocIngestInput; json: boolean })
  | ({ kind: 'extract'; input: CompanyExtractInput; json: boolean })
  | ({ kind: 'retrieve'; input: CompanyRetrieveInput; json: boolean })
  | { help: true };

export async function runCompany(engine: BrainEngine | null, args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if ('help' in parsed) {
    console.log(HELP);
    return;
  }
  if (!engine) {
    console.error('gbrain company: engine not connected');
    process.exit(1);
  }

  try {
    if (parsed.kind === 'meeting') {
      const noEmbed = parsed.input.noEmbed ?? !isAvailable('embedding');
      const result = await ingestCompanyMeeting(engine, { ...parsed.input, noEmbed });
      printMeetingResult(result, parsed.json);
    } else if (parsed.kind === 'doc') {
      const noEmbed = parsed.input.noEmbed ?? !isAvailable('embedding');
      const result = await ingestCompanyDoc(engine, { ...parsed.input, noEmbed });
      printDocResult(result, parsed.json);
    } else if (parsed.kind === 'extract') {
      const noEmbed = parsed.input.noEmbed ?? !isAvailable('embedding');
      const result = await extractCompanyMemory(engine, { ...parsed.input, noEmbed });
      printExtractResult(result, parsed.json);
    } else {
      const result = await answerCompanyQuestion(engine, parsed.input);
      printRetrieveResult(result, parsed.json);
    }
  } catch (e) {
    if (e instanceof CompanyIngestError || e instanceof CompanyExtractError || e instanceof CompanyRetrieveError) {
      console.error(`gbrain company: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}

function parseArgs(args: string[]): Parsed {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    return { help: true };
  }
  const [group, subcommand, ...rest] = args;
  if (group === 'extract') {
    const parsed = parseExtract([subcommand, ...rest].filter((v): v is string => typeof v === 'string'));
    return { kind: 'extract', input: parsed.input, json: parsed.json };
  }
  if (group === 'query' || group === 'ask' || group === 'decisions') {
    const parsed = parseRetrieve(group, [subcommand, ...rest].filter((v): v is string => typeof v === 'string'));
    return { kind: 'retrieve', input: parsed.input, json: parsed.json };
  }

  if (group !== 'ingest' || (subcommand !== 'meeting' && subcommand !== 'doc')) {
    console.error('Usage: gbrain company <ingest|extract|query|decisions> ...');
    console.error('Run `gbrain company --help` for details.');
    process.exit(2);
  }

  if (subcommand === 'meeting') {
    const parsed = parseMeeting(rest);
    return { kind: 'meeting', input: parsed.input, json: parsed.json };
  }
  const parsed = parseDoc(rest);
  return { kind: 'doc', input: parsed.input, json: parsed.json };
}

function parseMeeting(args: string[]): { input: CompanyMeetingIngestInput; json: boolean } {
  const base = parseBase(args);
  const positional: string[] = [];
  const attendees: string[] = [];
  const projects: string[] = [];
  const linkedDocs: CompanyLinkedDocInput[] = [];
  let title: string | undefined;
  let date: string | undefined;
  let slug: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const consumed = consumeBaseFlag(args, i);
    if (consumed !== null) { i += consumed; continue; }
    if (a === '--title') { title = requireValue(args, ++i, a); continue; }
    if (a === '--date') { date = requireValue(args, ++i, a); continue; }
    if (a === '--slug') { slug = requireValue(args, ++i, a); continue; }
    if (a === '--attendee') { attendees.push(...splitList(requireValue(args, ++i, a))); continue; }
    if (a === '--project') { projects.push(...splitList(requireValue(args, ++i, a))); continue; }
    if (a === '--doc') { linkedDocs.push({ path: requireValue(args, ++i, a) }); continue; }
    if (a.startsWith('--')) unknownFlag(a);
    positional.push(a);
  }

  if (positional.length !== 1) {
    console.error('Usage: gbrain company ingest meeting <transcript.txt|.md|.markdown> [options]');
    process.exit(2);
  }

  return {
    json: base.json,
    input: {
      transcriptPath: positional[0]!,
      title,
      date,
      slug,
      attendees,
      projects,
      linkedDocs,
      sourceId: base.sourceId,
      createdBy: base.createdBy,
      noEmbed: base.noEmbed,
    },
  };
}

function parseDoc(args: string[]): { input: CompanyDocIngestInput; json: boolean } {
  const base = parseBase(args);
  const positional: string[] = [];
  const projects: string[] = [];
  let title: string | undefined;
  let date: string | undefined;
  let slug: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const consumed = consumeBaseFlag(args, i);
    if (consumed !== null) { i += consumed; continue; }
    if (a === '--title') { title = requireValue(args, ++i, a); continue; }
    if (a === '--date') { date = requireValue(args, ++i, a); continue; }
    if (a === '--slug') { slug = requireValue(args, ++i, a); continue; }
    if (a === '--project') { projects.push(...splitList(requireValue(args, ++i, a))); continue; }
    if (a.startsWith('--')) unknownFlag(a);
    positional.push(a);
  }

  if (positional.length !== 1) {
    console.error('Usage: gbrain company ingest doc <document.txt|.md|.markdown> [options]');
    process.exit(2);
  }

  return {
    json: base.json,
    input: {
      docPath: positional[0]!,
      title,
      date,
      slug,
      projects,
      sourceId: base.sourceId,
      createdBy: base.createdBy,
      noEmbed: base.noEmbed,
    },
  };
}

function parseExtract(args: string[]): { input: CompanyExtractInput; json: boolean } {
  const base = parseBase(args);
  const positional: string[] = [];
  let limit: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const consumed = consumeBaseFlag(args, i);
    if (consumed !== null) { i += consumed; continue; }
    if (a === '--limit') {
      const value = requireValue(args, ++i, a);
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || String(parsed) !== value || parsed < 1 || parsed > 1000) {
        console.error('gbrain company: --limit must be an integer from 1 to 1000');
        process.exit(2);
      }
      limit = parsed;
      continue;
    }
    if (a.startsWith('--')) unknownFlag(a);
    positional.push(a);
  }

  if (positional.length === 0) {
    console.error('Usage: gbrain company extract all|<meeting-or-doc-slug> [more slugs...] [options]');
    process.exit(2);
  }
  if (positional.includes('all') && positional.length > 1) {
    console.error('gbrain company: "extract all" cannot be combined with explicit slugs');
    process.exit(2);
  }

  return {
    json: base.json,
    input: {
      slugs: positional[0] === 'all' ? undefined : positional,
      limit,
      sourceId: base.sourceId,
      createdBy: base.createdBy,
      noEmbed: base.noEmbed,
    },
  };
}

function parseRetrieve(group: string, args: string[]): { input: CompanyRetrieveInput; json: boolean } {
  const base = parseBase(args);
  const positional: string[] = [];
  let limit: number | undefined;
  let project: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const consumed = consumeBaseFlag(args, i);
    if (consumed !== null) { i += consumed; continue; }
    if (a === '--limit') {
      const value = requireValue(args, ++i, a);
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || String(parsed) !== value || parsed < 1 || parsed > 100) {
        console.error('gbrain company: query --limit must be an integer from 1 to 100');
        process.exit(2);
      }
      limit = parsed;
      continue;
    }
    if (a === '--project') { project = requireValue(args, ++i, a); continue; }
    if (a.startsWith('--')) unknownFlag(a);
    positional.push(a);
  }

  const question = positional.join(' ').trim()
    || (group === 'decisions' ? 'What did we decide?' : '');
  if (!question) {
    console.error('Usage: gbrain company query <question> [options]');
    process.exit(2);
  }

  return {
    json: base.json,
    input: {
      question,
      project,
      limit,
      sourceId: base.sourceId,
    },
  };
}

function parseBase(args: string[]): ParsedBase {
  const base: ParsedBase = {
    json: false,
    noEmbed: undefined,
    sourceId: undefined,
    createdBy: undefined,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') { base.json = true; continue; }
    if (a === '--no-embed') { base.noEmbed = true; continue; }
    if (a === '--source-id') { base.sourceId = requireValue(args, ++i, a); continue; }
    if (a === '--created-by') { base.createdBy = requireValue(args, ++i, a); continue; }
  }
  return base;
}

function consumeBaseFlag(args: string[], index: number): number | null {
  const a = args[index];
  if (a === '--json' || a === '--no-embed') return 0;
  if (a === '--source-id' || a === '--created-by') return 1;
  return null;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) {
    console.error(`gbrain company: ${flag} requires a value`);
    process.exit(2);
  }
  return value;
}

function splitList(value: string): string[] {
  return value.split(',').map((v) => v.trim()).filter(Boolean);
}

function unknownFlag(flag: string): never {
  console.error(`gbrain company: unknown flag ${flag}`);
  process.exit(2);
}

function printMeetingResult(result: CompanyMeetingIngestResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log('company ingest complete (trusted workspace pilot):');
  console.log(`  source:   ${result.source_id}`);
  console.log(`  meeting:  ${result.meeting.slug} (${result.meeting.status})`);
  for (const doc of result.docs) {
    console.log(`  doc:      ${doc.slug} (${doc.status})`);
  }
  for (const evidence of result.evidence) {
    console.log(`  evidence: ${evidence.slug} (${evidence.status})`);
  }
  console.log('  note:     local/manual ingest only; no live integrations or hosted writes enabled');
}

function printDocResult(result: CompanyDocIngestResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log('company ingest complete (trusted workspace pilot):');
  console.log(`  source:   ${result.source_id}`);
  console.log(`  doc:      ${result.doc.slug} (${result.doc.status})`);
  console.log(`  evidence: ${result.evidence.slug} (${result.evidence.status})`);
  console.log('  note:     local/manual ingest only; no live integrations or hosted writes enabled');
}

function printExtractResult(result: CompanyExtractionResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log('company extract complete (trusted workspace pilot):');
  console.log(`  source:      ${result.source_id}`);
  console.log(`  inputs:      ${result.inputs.length}`);
  console.log(`  decisions:   ${result.decisions.length}`);
  for (const page of result.decisions) {
    console.log(`    - ${page.slug} (${page.status})`);
  }
  console.log(`  commitments: ${result.commitments.length}`);
  for (const page of result.commitments) {
    console.log(`    - ${page.slug} (${page.status})`);
  }
  console.log(`  actions:     ${result.actions.length}`);
  for (const page of result.actions) {
    console.log(`    - ${page.slug} (${page.status})`);
  }
  if (result.skipped.length > 0) {
    console.log(`  skipped:     ${result.skipped.length}`);
  }
  console.log('  note:        local deterministic extraction only; no policy enforcement, hosted writes, or external execution enabled');
}

function printRetrieveResult(result: CompanyRetrieveResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log('company query result (trusted workspace pilot):');
  console.log(result.answer);
  if (result.citations.length > 0) {
    console.log('');
    console.log('Citations:');
    for (const citation of result.citations) {
      console.log(`  - ${citation.role}: ${citation.slug} (${citation.page_type})`);
    }
  }
  console.log('');
  console.log('note: local trusted-workspace retrieval only; query cache, hot-memory, code-intelligence, analytics, and dream-cycle outputs are not used');
}
