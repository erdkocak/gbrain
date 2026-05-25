# Company Permission Status

Reviewed hosted MCP operations enforce application-layer company permissions for
resolved company users. The protected path is narrow: normal users must reach
company memory through hosted MCP, the request must resolve one active company
user and current policy metadata, and the tool must be in the reviewed hosted
tool gate.

This is not a database-level ACL/RLS claim and not a durable-audit claim. Direct
database credentials remain admin/development only for normal company users.

Use `gbrain company permission-status --json` for the machine-readable status,
residual-risk register, and audit-hardening handoff.

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

## Not Claimed

- Database-level ACL/RLS enforcement.
- Direct database credentials for normal company users.
- Durable append-only policy audit.
- Policy-safe query cache reuse.
- Broad hosted skills, analytics aggregates, external execution, external
  research/model egress, maintenance automation, cron/webhooks, or subagent
  orchestration.
- Deployment parity for every OAuth/Postgres environment until the matrix runs
  in that environment.

## Audit Handoff

Audit hardening should add append-only events for hosted tool lists, tool calls,
policy decisions, read results, write results, derived writes, and denials.

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
Once durable audit is enabled, audit append failure should fail closed for
hosted company operations, with `whoami` as the only best-effort support-tool
exception because it returns no brain object content.
