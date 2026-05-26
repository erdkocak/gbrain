# Company Permission Status

Reviewed hosted MCP operations enforce application-layer company permissions for
resolved company users. The protected path is narrow: normal users must reach
company memory through hosted MCP, the request must resolve one active company
user and current policy metadata, and the tool must be in the reviewed hosted
tool gate.

Reviewed hosted company operations also write application-layer, hash-chained
audit rows for reviewed tool listing, tool calls, denials, read results,
reviewed writes, and derived-write decisions. Required hosted audit append
failures fail closed, except for the named support tool that returns no brain
object content.

This is not a database-level ACL/RLS claim, not direct-SQL protection, not signed
checkpointing, not external audit export, and not live OAuth/Postgres deployment
parity. Direct database credentials remain admin/development only for normal
company users.

Use `gbrain company permission-status --json` for the machine-readable status,
residual-risk register, and hosted auditability matrix.

## Supported Scope

- Hosted request context requires a resolved company user, current policy hash,
  allowed source scope, and fail-closed identity handling.
- Reviewed direct reads hide unreadable pages and page-backed rows as missing or
  empty results.
- Retrieval filters candidates before result return, eval capture, retrieval
  writeback, and reranker payload construction.
- Policy-scoped hosted retrieval bypasses semantic query cache lookup and
  writeback.
- The reviewed hosted write path is `put_page`; it requires writable target
  policies and stores derived visibility metadata.
- Link, graph, and code traversal enforce readable seed, frontier, edge,
  source, and snippet boundaries.
- Hosted tool listing and direct-call gates deny unreviewed tools.
- Hosted audit rows store hashes, ids/slugs, counts, policy metadata, routing
  metadata, status, previous hash, and event hash; raw bodies, chunk text,
  prompts, raw queries, snippets, file bytes, and model payloads are excluded.
- Permissioned audit reads are available through local/operator helpers and CLI
  paths. Configured audit readers get object-policy filtered output and denial
  reason redaction.
- Local hash-chain verification detects modified rows, missing middle rows, and
  chain-state mismatches in the application audit chain.

## Not Claimed

- Database-level ACL/RLS enforcement.
- Direct database credentials for normal company users.
- Enterprise audit guarantees, DB-level immutability, signed checkpoints,
  external anchoring, or compliance export.
- Hosted MCP audit-log read tools.
- Complete non-admin audit-reader visibility for opaque numeric object refs;
  those rows fail closed until refs become type-aware.
- Policy-safe query cache reuse.
- Broad hosted skills, analytics aggregates, external execution, external
  research/model egress, maintenance automation, cron/webhooks, or subagent
  orchestration.
- Deployment parity for every OAuth/Postgres environment until the matrix runs
  in that environment.

## Auditability Matrix

Covered hosted audit rows:

- tool listing: `company.hosted.tool_list`
- allowed tool calls: `company.hosted.tool_call`
- request, policy, source, local-only, write-gate, hosted-tool, and unknown-tool
  denials: `company.hosted.denial`
- direct reads, retrieval, graph/link/code traversal results:
  `company.hosted.read_result`
- reviewed hosted writes: `company.hosted.write_result`
- derived visibility decisions: `company.hosted.derived_write`

Minimum event fields:

- event id, type, timestamp, request id, session id
- user id, client id, client name, transport
- operation and source scope
- policy decision id, version, hash, readable/writable policy-scope hashes
- args hash and content/query hash
- result count and object ids or slugs
- status, denial reason, previous event hash, event hash

Audit rows should store hashes, ids, counts, and policy metadata. They should
not store page bodies, chunk text, prompts, file bytes, or raw query content.
Audit append failure fails closed for hosted company operations, with `whoami` as
the only best-effort support-tool exception because it returns no brain object
content.
