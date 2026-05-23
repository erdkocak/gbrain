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
import { isAvailable } from '../core/ai/gateway.ts';

const HELP = `Usage:
  gbrain company ingest meeting <transcript.txt|.md|.markdown> [options]
  gbrain company ingest doc <document.txt|.md|.markdown> [options]

Stage 1C local/manual company ingestion for a trusted workspace pilot.
Writes meeting, doc, and evidence pages into the company source with file
provenance. This command does not start live integrations, cron, webhooks,
background connectors, or hosted write access.

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

Shared options:
  --source-id ID         Override company primary source (default: company)
  --created-by ID        Reserved provenance placeholder, not an ACL identity
  --no-embed             Skip embeddings
  --json                 JSON receipt
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
    const noEmbed = parsed.input.noEmbed ?? !isAvailable('embedding');
    if (parsed.kind === 'meeting') {
      const result = await ingestCompanyMeeting(engine, { ...parsed.input, noEmbed });
      printMeetingResult(result, parsed.json);
    } else {
      const result = await ingestCompanyDoc(engine, { ...parsed.input, noEmbed });
      printDocResult(result, parsed.json);
    }
  } catch (e) {
    if (e instanceof CompanyIngestError) {
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
  if (group !== 'ingest' || (subcommand !== 'meeting' && subcommand !== 'doc')) {
    console.error('Usage: gbrain company ingest <meeting|doc> ...');
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
