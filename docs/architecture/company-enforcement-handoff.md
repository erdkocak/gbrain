# Company Enforcement Handoff

Company policy is representable, resolvable, inspectable, attached to company-mode
objects, and enforced on the reviewed hosted MCP operation path. This handoff
records the enforcement design and the remaining boundaries that are still not
claimed. For current product wording, residual risks, and auditability fields,
see `docs/architecture/company-permission-status.md`.

Use `gbrain company enforcement-handoff --json` for the machine-readable version of this handoff.

## Cache Strategy

Company secure paths must run with query cache disabled until policy-safe cache keys exist.

The current `query_cache` key is scoped by source and search knobs. That is not enough for object policy because two users can share a source while having different readable policy sets. Permission enforcement should first force `useCache: false` for hosted or secure company requests. Cache can be re-enabled only after cache lookup and writeback include:

- `brain_id`
- source scope hash
- policy hash
- readable policy ids hash
- company user id or policy-scope subject
- embedding column and model
- search knobs hash
- query text or query embedding hash

Stored cache rows must contain only post-policy-filtered result ids and metadata. They must not store unfiltered candidate sets or reranker input text for secure company requests. Policy hash changes, object visibility changes, source scope changes, embedding-column changes, and page deletion must miss or invalidate cache rows.

## Graph Traversal

Graph traversal must enforce readability at three points:

- seed page: reject or return empty if the starting page is not readable
- frontier expansion: join through page visibility before each recursive step
- returned edge: return an edge only if both endpoints are readable

This applies to `traverse_graph`, `get_links`, `get_backlinks`, and structural two-pass search expansion. Source routing remains a separate boundary; sources are not ACL groups.

## Derived Memory

Derived writes must store object policy metadata and must not combine incompatible visibility sets silently.

Decisions and commitments inherit visibility from one input, intersect visibility across multiple inputs, and block on empty intersections. Actions and follow-up drafts may read only readable actions, commitments, decisions, and evidence. Facts must either carry direct object-policy metadata or enforce through their source or owner page before recall, trajectory, contradiction, anomaly, salience, or consolidation reads. Synthesis, `think`, and dream-cycle outputs must filter every input before prompt construction and store derived visibility on saved outputs.

## First Hooks

The reviewed hosted operation path uses these hooks in this order:

1. Require resolved company request context for secure hosted company operations.
2. Add direct read filters for pages, chunks, files, facts, takes, salience, anomalies, contradictions, and trajectory.
3. Add write authorization for hosted writes and derived company outputs.
4. Filter keyword, vector, hybrid, image, and two-pass search before rerank, token budgeting, eval capture, or `last_retrieved_at` writeback.
5. Disable company secure cache, then add policy-safe cache keys before re-enabling.
6. Enforce graph seed/frontier/endpoint readability.
7. Keep broad hosted skills denied until each skill is explicitly routed through policy enforcement.
8. Keep hosted audit coverage aligned with reviewed operation boundaries.

## Residual Risks

Direct database credentials remain admin/development only until matching database-level enforcement exists.

Related tables such as `content_chunks`, `links`, `timeline_entries`, `facts`, `takes`, `raw_data`, `files`, and job artifacts must either join through pages or gain dedicated policy columns before secure reads expose them.

External model payloads are enforcement boundaries. Reranker, expansion, extraction, and synthesis prompts must receive only readable text.

Hosted audit rows make reviewed hosted reads, writes, derivations, and policy
decisions reconstructable at the application layer. Signed checkpoints,
DB-level immutability, hosted audit-read MCP exposure, and live OAuth/Postgres
parity remain outside this handoff.
