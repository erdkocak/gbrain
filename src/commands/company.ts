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
import {
  draftCompanyFollowUp,
  CompanyFollowUpError,
  type CompanyFollowUpDraftResult,
  type CompanyFollowUpInput,
} from '../core/company-followup.ts';
import {
  buildCompanyHostedSurfaceConfig,
  type CompanyHostedSurfaceConfig,
} from '../core/company-hosted-surface.ts';
import {
  CompanyPolicyInspectError,
  inspectCompanyPolicyGrants,
  inspectCompanyPolicySeed,
  previewCompanyPolicyRequestContext,
  COMPANY_POLICY_INSPECTION_GUARDRAIL,
  type CompanyPolicyGrantInspection,
  type CompanyPolicySeedInspection,
  type CompanyRequestContextPreview,
  type CompanyRequestContextPreviewInput,
} from '../core/company-policy-inspect.ts';
import {
  buildCompanyEnforcementHandoff,
  type CompanyEnforcementHandoff,
} from '../core/company-enforcement-handoff.ts';
import { isAvailable } from '../core/ai/gateway.ts';

const HELP = `Usage:
  gbrain company ingest meeting <transcript.txt|.md|.markdown> [options]
  gbrain company ingest doc <document.txt|.md|.markdown> [options]
  gbrain company extract all [options]
  gbrain company extract <meeting-or-doc-slug> [more slugs...] [options]
  gbrain company query <question> [options]
  gbrain company decisions [question terms] [options]
  gbrain company follow-up draft [options]
  gbrain company hosted-surface [options]
  gbrain company policy seed [options]
  gbrain company policy grants <user-id> [options]
  gbrain company policy context [identity options]
  gbrain company enforcement-handoff [options]

Local/manual company memory for a trusted workspace pilot.
Ingest writes meeting, doc, and evidence pages with file provenance. Extract
derives decisions, commitments, and follow-up action candidates from trusted
meeting/doc pages. Query answers from company layout pages with citations to
meetings, docs, and evidence. Follow-up drafting produces local drafts only;
it does not send email, post messages, create tickets, run webhooks, invoke
subagents, or execute external actions. Hosted skill exposure is deny-by-
default for trusted pilot clients only. Company policies are represented and
resolvable for local/admin inspection, but not yet fully enforced.
The enforcement handoff command prints permission-enforcement hook order and residual risks;
it is a plan, not an authorization gate.
These commands do not start live integrations, cron, webhooks, background
connectors, hosted write access, query cache, hot-memory, code-intelligence
reads, analytics reads, or dream-cycle outputs.

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

Follow-up options:
  --owner NAME           Restrict drafts to one owner
  --project NAME         Restrict drafts to one project
  --limit N              Max follow-up drafts (1-100, default: 10)
  --include-closed       Include completed/closed action and commitment pages

Policy inspection options:
  --user-id ID           Preview/evaluate a company policy user
  --email EMAIL          Resolve request identity by email
  --idp-subject VALUE    Resolve request identity by IdP/OAuth subject
  --client-id ID         Preview hosted OAuth client identity mapping
  --client-name NAME     Preview hosted OAuth client-name mapping
  --local                Preview trusted local CLI context
  --remote               Preview remote/MCP context (default)
  --request-id ID        Override preview request id
  --session-id ID        Include a preview session id
  --allowed-source ID    Repeatable; comma-separated values also accepted

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
  | ({ kind: 'followup'; input: CompanyFollowUpInput; json: boolean })
  | ({ kind: 'hosted-surface'; json: boolean })
  | ({ kind: 'policy-seed'; sourceId: string | undefined; json: boolean })
  | ({ kind: 'policy-grants'; userId: string; sourceId: string | undefined; json: boolean })
  | ({ kind: 'policy-context'; input: CompanyRequestContextPreviewInput; json: boolean })
  | ({ kind: 'enforcement-handoff'; json: boolean })
  | { help: true };

export async function runCompany(engine: BrainEngine | null, args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if ('help' in parsed) {
    console.log(HELP);
    return;
  }
  if (parsed.kind === 'enforcement-handoff') {
    printEnforcementHandoff(buildCompanyEnforcementHandoff(), parsed.json);
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
    } else if (parsed.kind === 'retrieve') {
      const result = await answerCompanyQuestion(engine, parsed.input);
      printRetrieveResult(result, parsed.json);
    } else if (parsed.kind === 'followup') {
      const result = await draftCompanyFollowUp(engine, parsed.input);
      printFollowUpResult(result, parsed.json);
    } else if (parsed.kind === 'hosted-surface') {
      const result = buildCompanyHostedSurfaceConfig();
      printHostedSurfaceResult(result, parsed.json);
    } else if (parsed.kind === 'policy-seed') {
      const result = await inspectCompanyPolicySeed(engine, { sourceId: parsed.sourceId });
      printPolicySeedInspection(result, parsed.json);
    } else if (parsed.kind === 'policy-grants') {
      const result = await inspectCompanyPolicyGrants(engine, { userId: parsed.userId, sourceId: parsed.sourceId });
      printPolicyGrantInspection(result, parsed.json);
    } else {
      const result = await previewCompanyPolicyRequestContext(engine, parsed.input);
      printPolicyContextPreview(result, parsed.json);
    }
  } catch (e) {
    if (e instanceof CompanyPolicyInspectError) {
      console.error(`gbrain company: ${e.message}`);
      console.error(`gbrain company: ${COMPANY_POLICY_INSPECTION_GUARDRAIL}`);
      process.exit(1);
    }
    if (
      e instanceof CompanyIngestError
      || e instanceof CompanyExtractError
      || e instanceof CompanyRetrieveError
      || e instanceof CompanyFollowUpError
    ) {
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
  if (group === 'follow-up' || group === 'followup') {
    const parsed = parseFollowUp([subcommand, ...rest].filter((v): v is string => typeof v === 'string'));
    return { kind: 'followup', input: parsed.input, json: parsed.json };
  }
  if (group === 'hosted-surface' || group === 'surface') {
    const surfaceArgs = [subcommand, ...rest].filter((v): v is string => typeof v === 'string');
    const base = parseBase(surfaceArgs);
    for (const arg of surfaceArgs) {
      if (arg.startsWith('--') && arg !== '--json') unknownFlag(arg);
      if (!arg.startsWith('--')) {
        console.error('Usage: gbrain company hosted-surface [--json]');
        process.exit(2);
      }
    }
    return { kind: 'hosted-surface', json: base.json };
  }
  if (group === 'policy' || group === 'policies') {
    return parsePolicy([subcommand, ...rest].filter((v): v is string => typeof v === 'string'));
  }
  if (
    group === 'enforcement-handoff'
    || group === 'handoff'
  ) {
    const handoffArgs = [subcommand, ...rest].filter((v): v is string => typeof v === 'string');
    let json = false;
    for (const arg of handoffArgs) {
      if (arg === '--json') { json = true; continue; }
      if (arg.startsWith('--')) unknownFlag(arg);
      console.error('Usage: gbrain company enforcement-handoff [--json]');
      process.exit(2);
    }
    return { kind: 'enforcement-handoff', json };
  }

  if (group !== 'ingest' || (subcommand !== 'meeting' && subcommand !== 'doc')) {
    console.error('Usage: gbrain company <ingest|extract|query|decisions|follow-up|hosted-surface|policy|enforcement-handoff> ...');
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

function parseFollowUp(args: string[]): { input: CompanyFollowUpInput; json: boolean } {
  if (args[0] !== 'draft') {
    console.error('Usage: gbrain company follow-up draft [options]');
    process.exit(2);
  }
  const base = parseBase(args);
  const positional: string[] = [];
  let limit: number | undefined;
  let project: string | undefined;
  let owner: string | undefined;
  let includeClosed = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const consumed = consumeBaseFlag(args, i);
    if (consumed !== null) { i += consumed; continue; }
    if (a === 'draft') continue;
    if (a === '--limit') {
      const value = requireValue(args, ++i, a);
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || String(parsed) !== value || parsed < 1 || parsed > 100) {
        console.error('gbrain company: follow-up --limit must be an integer from 1 to 100');
        process.exit(2);
      }
      limit = parsed;
      continue;
    }
    if (a === '--project') { project = requireValue(args, ++i, a); continue; }
    if (a === '--owner') { owner = requireValue(args, ++i, a); continue; }
    if (a === '--include-closed') { includeClosed = true; continue; }
    if (a.startsWith('--')) unknownFlag(a);
    positional.push(a);
  }

  if (positional.length > 0) {
    console.error('Usage: gbrain company follow-up draft [options]');
    process.exit(2);
  }

  return {
    json: base.json,
    input: {
      sourceId: base.sourceId,
      owner,
      project,
      limit,
      includeClosed,
    },
  };
}

function parsePolicy(args: string[]): Parsed {
  const action = args[0];
  if (action === 'seed') {
    const commandArgs = args.slice(1);
    const base = parsePolicyBase(commandArgs);
    const positional = collectPolicyPositionals(commandArgs);
    if (positional.length > 0) {
      console.error('Usage: gbrain company policy seed [--source-id ID] [--json]');
      process.exit(2);
    }
    return { kind: 'policy-seed', sourceId: base.sourceId, json: base.json };
  }

  if (action === 'grants' || action === 'grant' || action === 'user') {
    const commandArgs = args.slice(1);
    const base = parsePolicyBase(commandArgs);
    const positional: string[] = [];
    let userId: string | undefined;
    for (let i = 0; i < commandArgs.length; i++) {
      const a = commandArgs[i]!;
      const consumed = consumePolicyBaseFlag(commandArgs, i);
      if (consumed !== null) { i += consumed; continue; }
      if (a === '--user-id') { userId = requireValue(commandArgs, ++i, a); continue; }
      if (a.startsWith('--')) unknownFlag(a);
      positional.push(a);
    }
    if (positional.length > 1 || (userId && positional.length > 0)) {
      console.error('Usage: gbrain company policy grants <user-id> [--source-id ID] [--json]');
      process.exit(2);
    }
    const resolvedUserId = userId ?? positional[0];
    if (!resolvedUserId) {
      console.error('Usage: gbrain company policy grants <user-id> [--source-id ID] [--json]');
      process.exit(2);
    }
    return { kind: 'policy-grants', userId: resolvedUserId, sourceId: base.sourceId, json: base.json };
  }

  if (action === 'context' || action === 'request-context' || action === 'preview') {
    const commandArgs = args.slice(1);
    const base = parsePolicyBase(commandArgs);
    const positional: string[] = [];
    const allowedSources: string[] = [];
    let requestId: string | undefined;
    let sessionId: string | undefined;
    let remote = true;
    const identity: CompanyRequestContextPreviewInput['identity'] = {};

    for (let i = 0; i < commandArgs.length; i++) {
      const a = commandArgs[i]!;
      const consumed = consumePolicyBaseFlag(commandArgs, i);
      if (consumed !== null) { i += consumed; continue; }
      if (a === '--user-id') { identity.userId = requireValue(commandArgs, ++i, a); continue; }
      if (a === '--email') { identity.email = requireValue(commandArgs, ++i, a); continue; }
      if (a === '--idp-subject') { identity.idpSubject = requireValue(commandArgs, ++i, a); continue; }
      if (a === '--client-id') { identity.clientId = requireValue(commandArgs, ++i, a); continue; }
      if (a === '--client-name') { identity.clientName = requireValue(commandArgs, ++i, a); continue; }
      if (a === '--request-id') { requestId = requireValue(commandArgs, ++i, a); continue; }
      if (a === '--session-id') { sessionId = requireValue(commandArgs, ++i, a); continue; }
      if (a === '--allowed-source' || a === '--allowed-sources') {
        allowedSources.push(...splitList(requireValue(commandArgs, ++i, a)));
        continue;
      }
      if (a === '--local') { remote = false; continue; }
      if (a === '--remote') { remote = true; continue; }
      if (a.startsWith('--')) unknownFlag(a);
      positional.push(a);
    }
    if (positional.length > 0) {
      console.error('Usage: gbrain company policy context [identity options] [--source-id ID] [--json]');
      process.exit(2);
    }
    return {
      kind: 'policy-context',
      input: {
        sourceId: base.sourceId,
        requestId,
        sessionId,
        remote,
        allowedSources: allowedSources.length > 0 ? allowedSources : undefined,
        identity,
      },
      json: base.json,
    };
  }

  console.error('Usage: gbrain company policy <seed|grants|context> ...');
  process.exit(2);
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

function parsePolicyBase(args: string[]): Pick<ParsedBase, 'json' | 'sourceId'> {
  const base = { json: false, sourceId: undefined as string | undefined };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') { base.json = true; continue; }
    if (a === '--source-id') { base.sourceId = requireValue(args, ++i, a); continue; }
  }
  return base;
}

function consumeBaseFlag(args: string[], index: number): number | null {
  const a = args[index];
  if (a === '--json' || a === '--no-embed') return 0;
  if (a === '--source-id' || a === '--created-by') return 1;
  return null;
}

function consumePolicyBaseFlag(args: string[], index: number): number | null {
  const a = args[index];
  if (a === '--json') return 0;
  if (a === '--source-id') return 1;
  return null;
}

function collectPolicyPositionals(args: string[]): string[] {
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const consumed = consumePolicyBaseFlag(args, i);
    if (consumed !== null) { i += consumed; continue; }
    if (a.startsWith('--')) unknownFlag(a);
    positional.push(a);
  }
  return positional;
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

function printFollowUpResult(result: CompanyFollowUpDraftResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log('company follow-up draft (trusted workspace pilot):');
  console.log(result.draft_text);
  console.log('');
  console.log(`drafts: ${result.drafts.length}`);
  if (result.citations.length > 0) {
    console.log('Citations:');
    for (const citation of result.citations) {
      console.log(`  - ${citation.role}: ${citation.slug} (${citation.page_type})`);
    }
  }
  console.log('');
  console.log('note: draft-only local output; email, Slack, tickets, calendars, webhooks, external APIs, shell jobs, and subagents are disabled');
}

function printHostedSurfaceResult(result: CompanyHostedSurfaceConfig, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log('company hosted surface (trusted workspace pilot):');
  console.log(`  mode:      ${result.mode}`);
  console.log(`  security:  ${result.security_claim}`);
  console.log(`  skillgate: ${result.skill_gate.default} by default`);
  console.log('  allowlist:');
  for (const rule of result.skill_gate.allowlist) {
    const suffix = rule.advisory_only ? ' (advisory only)' : '';
    console.log(`    - ${rule.name}${suffix}`);
  }
  console.log('  reviewed tools:');
  for (const rule of result.tool_gate.reviewed_tools) {
    console.log(`    - ${rule.name}`);
  }
  console.log('  disabled:');
  for (const surface of result.disabled_surfaces) {
    console.log(`    - ${surface}`);
  }
  console.log('  note: trusted pilot clients only; normal secure users still need permission enforcement');
}

function printPolicySeedInspection(result: CompanyPolicySeedInspection, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log('company policy seed inspection (trusted workspace pilot):');
  console.log(`  source:          ${result.source_id}`);
  console.log(`  policy version:  ${result.policy_metadata?.policy_version ?? '(missing metadata)'}`);
  console.log(`  policy hash:     ${result.policy_metadata?.policy_hash ?? '(missing metadata)'}`);
  console.log(`  default:         ${result.policy_storage.default_policy_id} (${result.policy_storage.default_decision})`);
  console.log(`  users:           ${result.policy_storage.active_users}/${result.policy_storage.users} active`);
  console.log(`  groups:          ${result.policy_storage.groups}`);
  console.log(`  policies:        ${result.policy_storage.policies}`);
  console.log(`  grants:          ${result.policy_storage.grants}`);
  console.log(`  path defaults:   ${result.policy_storage.path_defaults}`);
  console.log(`  hosted skills:   ${result.surface_summary.hosted_skill_default} by default`);
  console.log(`  object policy:   ${result.surface_summary.object_policy_kind}`);
  console.log(`  guardrail:       ${result.guardrail}`);
}

function printPolicyGrantInspection(result: CompanyPolicyGrantInspection, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log('company policy grant inspection (trusted workspace pilot):');
  console.log(`  source:     ${result.source_id}`);
  console.log(`  user:       ${result.user_id}`);
  console.log(`  known:      ${result.effective_grants.known_user ? 'yes' : 'no'}`);
  console.log(`  active:     ${result.effective_grants.active_user ? 'yes' : 'no'}`);
  console.log(`  groups:     ${formatList(result.effective_grants.group_ids)}`);
  console.log(`  readable:   ${formatList(result.effective_grants.readable_policy_ids)}`);
  console.log(`  writable:   ${formatList(result.effective_grants.writable_policy_ids)}`);
  console.log(`  decision:   ${result.effective_grants.default_decision} by default`);
  console.log(`  guardrail:  ${result.guardrail}`);
}

function printPolicyContextPreview(result: CompanyRequestContextPreview, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const ctx = result.request_context;
  console.log('company request-context preview (trusted workspace pilot):');
  console.log(`  source:        ${result.source_id}`);
  console.log(`  request id:    ${ctx.requestId}`);
  console.log(`  transport:     ${ctx.transport}`);
  console.log(`  identity:      ${ctx.identityStatus} via ${ctx.identitySource}`);
  console.log(`  user:          ${ctx.userId ?? '(none)'}`);
  console.log(`  groups:        ${formatList(ctx.groupIds)}`);
  console.log(`  readable:      ${formatList(ctx.readablePolicyIds)}`);
  console.log(`  writable:      ${formatList(ctx.writablePolicyIds)}`);
  console.log(`  policy id:     ${ctx.policyDecisionId}`);
  console.log(`  enforcement:   ${ctx.enforcement}`);
  console.log(`  guardrail:     ${result.guardrail}`);
}

function printEnforcementHandoff(result: CompanyEnforcementHandoff, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log('company enforcement handoff:');
  console.log(`  kind:       ${result.kind}`);
  console.log(`  guardrail:  ${result.guardrail}`);
  console.log(`  cache:      ${result.cache_strategy.decision}`);
  console.log('');
  console.log('First hooks:');
  for (const hook of result.first_hooks) {
    const blocker = hook.blocks_secure_claim_until_done ? 'blocks secure claim' : 'audit follow-up';
    console.log(`  - ${hook.priority} ${hook.id}: ${hook.surface} (${blocker})`);
  }
  console.log('');
  console.log('Derived-memory surfaces:');
  for (const item of result.derived_memory_plan) {
    console.log(`  - ${item.surface}: ${item.residual_owner}`);
  }
  console.log('');
  console.log('Residual risks:');
  for (const risk of result.residual_risks) {
    console.log(`  - ${risk.id}: ${risk.owner}`);
  }
}

function formatList(values: readonly string[]): string {
  return values.length > 0 ? values.join(', ') : '(none)';
}
