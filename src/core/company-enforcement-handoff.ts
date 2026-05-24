export const COMPANY_ENFORCEMENT_HANDOFF_KIND = 'company_enforcement_handoff';
export const COMPANY_ENFORCEMENT_HANDOFF_GUARDRAIL =
  'This handoff is a planning checklist only; company policy is represented and resolvable but not yet fully enforced.';

export type CompanyHandoffOwner = 'permission_enforcement' | 'audit_hardening';
export type CompanyHookPriority = 'p0' | 'p1' | 'p2';

export interface CompanyEnforcementCacheStrategy {
  decision: 'disable_company_secure_cache_until_policy_safe_keys';
  current_policy_state: string;
  permission_enforcement_v1_rule: string;
  policy_safe_key_plan: {
    required_fields: string[];
    stored_result_rule: string;
    invalidation_rule: string;
    reranker_rule: string;
  };
  implementation_hooks: string[];
}

export interface CompanyEnforcementGraphPlan {
  rule: string;
  implementation_hooks: string[];
  required_checks: string[];
}

export interface CompanyEnforcementDerivedMemoryPlan {
  surface: string;
  permission_enforcement_rule: string;
  implementation_hooks: string[];
  residual_owner: CompanyHandoffOwner;
}

export interface CompanyEnforcementHook {
  id: string;
  priority: CompanyHookPriority;
  surface: string;
  files: string[];
  action: string;
  blocks_secure_claim_until_done: boolean;
}

export interface CompanyResidualRisk {
  id: string;
  owner: CompanyHandoffOwner;
  risk: string;
  requirement: string;
}

export interface CompanyEnforcementHandoff {
  schema_version: 1;
  kind: typeof COMPANY_ENFORCEMENT_HANDOFF_KIND;
  guardrail: typeof COMPANY_ENFORCEMENT_HANDOFF_GUARDRAIL;
  cache_strategy: CompanyEnforcementCacheStrategy;
  graph_traversal_plan: CompanyEnforcementGraphPlan;
  derived_memory_plan: CompanyEnforcementDerivedMemoryPlan[];
  first_hooks: CompanyEnforcementHook[];
  residual_risks: CompanyResidualRisk[];
  secure_claim_blockers: string[];
}

export function buildCompanyEnforcementHandoff(): CompanyEnforcementHandoff {
  return {
    schema_version: 1,
    kind: COMPANY_ENFORCEMENT_HANDOFF_KIND,
    guardrail: COMPANY_ENFORCEMENT_HANDOFF_GUARDRAIL,
    cache_strategy: {
      decision: 'disable_company_secure_cache_until_policy_safe_keys',
      current_policy_state:
        'query_cache remains keyed by source and search knobs for local/trusted paths; policy-scoped company retrieval disables cache lookup and writeback.',
      permission_enforcement_v1_rule:
        'For any hosted or secure company path, force cache off before candidate retrieval unless policy-safe keys and post-filtered cache rows are implemented.',
      policy_safe_key_plan: {
        required_fields: [
          'brain_id',
          'source_scope_hash',
          'policy_hash',
          'readable_policy_ids_hash',
          'company_user_id_or_scope_subject',
          'embedding_column_and_model',
          'search_knobs_hash',
          'query_text_or_embedding_hash',
        ],
        stored_result_rule:
          'Cache rows may store only post-policy-filtered result ids and metadata; never cache unfiltered candidates or reranker input text for secure company requests.',
        invalidation_rule:
          'Policy hash, object visibility metadata changes, source scope changes, embedding-column changes, or page deletion must miss or invalidate cached rows.',
        reranker_rule:
          'Reranker must run only after policy filtering; cache hits must never cause unreadable text to be sent to rerank.',
      },
      implementation_hooks: [
        'src/core/search/hybrid.ts: hybridSearchCached cache lookup/writeback',
        'src/core/search/query-cache.ts: SemanticQueryCache key, lookup, store, clear, stats',
        'src/core/operations.ts: query image branch and text query branch',
        'src/commands/cache.ts: cache inspection and clear operations',
      ],
    },
    graph_traversal_plan: {
      rule:
        'Graph traversal must prove the seed page, every expanded frontier page, and every returned edge endpoint is readable by the request context.',
      implementation_hooks: [
        'src/core/operations.ts: traverse_graph handler',
        'src/core/engine.ts: traverseGraph and traversePaths options',
        'src/core/postgres-engine.ts: graph traversal SQL',
        'src/core/pglite-engine.ts: graph traversal SQL',
        'src/core/operations.ts: get_links and get_backlinks handlers',
      ],
      required_checks: [
        'Reject or return empty when the seed page is not readable.',
        'Join pages/object visibility before each recursive expansion.',
        'Return an edge only when both endpoints are readable.',
        'Keep source routing separate from policy filtering; sources are not ACL groups.',
        'Do not expose unreadable titles, slugs, link metadata, or path existence through graph misses.',
      ],
    },
    derived_memory_plan: [
      {
        surface: 'company decisions and commitments',
        permission_enforcement_rule:
          'Derived pages inherit or intersect source visibility; writes require write permission for the resolved target policy and must block on empty intersections.',
        implementation_hooks: [
          'src/core/company-extract.ts',
          'src/core/company-object-policy.ts',
          'src/core/operations.ts: put_page',
        ],
        residual_owner: 'permission_enforcement',
      },
      {
        surface: 'actions and follow-up drafts',
        permission_enforcement_rule:
          'Draft generation may read only readable actions, commitments, decisions, and evidence; external execution remains disabled until explicit post-policy connectors exist.',
        implementation_hooks: [
          'src/core/company-followup.ts',
          'src/core/company-retrieve.ts',
          'src/commands/company.ts',
        ],
        residual_owner: 'permission_enforcement',
      },
      {
        surface: 'facts and hot memory',
        permission_enforcement_rule:
          'Facts must carry direct object-policy metadata or enforce through their source/owner page before recall, trajectory, contradiction, anomaly, salience, or consolidation reads.',
        implementation_hooks: [
          'src/core/operations.ts: recall, extract_facts, find_trajectory, find_contradictions, find_anomalies, get_recent_salience',
          'src/core/facts-fence.ts',
          'src/core/facts/backstop.ts',
          'src/core/trajectory.ts',
        ],
        residual_owner: 'permission_enforcement',
      },
      {
        surface: 'synthesis and think outputs',
        permission_enforcement_rule:
          'Synthesis input gathering, graph expansion, takes, facts, and saved outputs must all use the request context and store derived visibility metadata.',
        implementation_hooks: [
          'src/core/operations.ts: think',
          'src/core/think/gather.ts',
          'src/core/think/index.ts',
          'src/commands/think.ts',
        ],
        residual_owner: 'permission_enforcement',
      },
      {
        surface: 'dream-cycle synthesis, patterns, and consolidation',
        permission_enforcement_rule:
          'Protected local phases remain trusted-operator only until every read input and written output carries request/policy context or is explicitly excluded from hosted secure paths.',
        implementation_hooks: [
          'src/commands/dream.ts',
          'src/core/cycle/transcript-discovery.ts',
          'src/core/minions/handlers',
        ],
        residual_owner: 'permission_enforcement',
      },
    ],
    first_hooks: [
      {
        id: 'request-context-required',
        priority: 'p0',
        surface: 'hosted MCP dispatch',
        files: [
          'src/core/operations.ts',
          'src/commands/serve-http.ts',
          'src/mcp/server.ts',
          'src/core/company-request-context.ts',
        ],
        action:
          'Require a resolved company request context for secure company operations; unresolved or ambiguous identities must fail closed before operation handlers run.',
        blocks_secure_claim_until_done: true,
      },
      {
        id: 'direct-read-filter',
        priority: 'p0',
        surface: 'page, file, fact, take, and analytics reads',
        files: [
          'src/core/operations.ts',
          'src/core/engine.ts',
          'src/core/postgres-engine.ts',
          'src/core/pglite-engine.ts',
        ],
        action:
          'Apply readable policy filters at SQL/engine boundaries for get_page, list_pages, get_chunks/history, file metadata/URLs, facts, takes, salience, anomalies, contradictions, and trajectory.',
        blocks_secure_claim_until_done: true,
      },
      {
        id: 'write-authorization',
        priority: 'p0',
        surface: 'all hosted writes',
        files: [
          'src/core/operations.ts',
          'src/core/company-object-policy.ts',
          'src/core/company-ingest.ts',
          'src/core/company-extract.ts',
          'src/core/facts/backstop.ts',
        ],
        action:
          'Require writable policy ids for put_page, file_upload attachment, extract_facts, derived company writes, and any future hosted write path; store policy decision metadata with the output.',
        blocks_secure_claim_until_done: true,
      },
      {
        id: 'search-before-rerank',
        priority: 'p0',
        surface: 'keyword, vector, hybrid, image, and reranker retrieval',
        files: [
          'src/core/search/hybrid.ts',
          'src/core/search/rerank.ts',
          'src/core/search/by-image.ts',
          'src/core/operations.ts',
          'src/core/postgres-engine.ts',
          'src/core/pglite-engine.ts',
        ],
        action:
          'Filter unreadable candidates before RRF, backlink/salience/recency boosts, two-pass expansion, reranker payload construction, token budgeting, eval capture, and last_retrieved_at writeback.',
        blocks_secure_claim_until_done: true,
      },
      {
        id: 'cache-disabled-then-keyed',
        priority: 'p0',
        surface: 'query cache',
        files: [
          'src/core/search/hybrid.ts',
          'src/core/search/query-cache.ts',
          'src/commands/cache.ts',
        ],
        action:
          'Disable cache for secure company requests first; only re-enable after policy-safe cache keys and post-filtered stored results are implemented.',
        blocks_secure_claim_until_done: true,
      },
      {
        id: 'graph-filter',
        priority: 'p1',
        surface: 'graph traversal and link reads',
        files: [
          'src/core/operations.ts',
          'src/core/engine.ts',
          'src/core/postgres-engine.ts',
          'src/core/pglite-engine.ts',
        ],
        action:
          'Enforce readability at seed, frontier, and endpoint stages for traverse_graph, get_links, get_backlinks, and structural two-pass search expansion.',
        blocks_secure_claim_until_done: true,
      },
      {
        id: 'skill-gate',
        priority: 'p1',
        surface: 'hosted skills and agent-facing tools',
        files: [
          'skills/RESOLVER.md',
          'src/core/company-hosted-surface.ts',
          'src/core/operations.ts',
        ],
        action:
          'Keep broad hosted skills denied until their reads, writes, subagent use, external egress, and cache behavior are explicitly routed through policy enforcement.',
        blocks_secure_claim_until_done: true,
      },
      {
        id: 'audit-envelope',
        priority: 'p2',
        surface: 'durable audit',
        files: [
          'src/core/operations.ts',
          'src/core/migrate.ts',
          'src/core/company-request-context.ts',
        ],
        action:
          'After enforcement hooks exist, add append-only audit rows with request id, user id, source scope, policy decision id, policy version/hash, target object policy, operation, and result counts.',
        blocks_secure_claim_until_done: false,
      },
    ],
    residual_risks: [
      {
        id: 'direct-db-credentials',
        owner: 'permission_enforcement',
        risk: 'Normal secure users with direct database credentials bypass application policy filters.',
        requirement:
          'Keep direct DB credentials admin/development only, or add DB-level RLS that matches application policy before offering them to normal users.',
      },
      {
        id: 'unfiltered-related-tables',
        owner: 'permission_enforcement',
        risk: 'content_chunks, links, timeline_entries, facts, takes, raw_data, files, and job artifacts may not carry direct policy columns.',
        requirement:
          'Join through owning/source pages or add dedicated policy columns before exposing secure reads from each related table.',
      },
      {
        id: 'derived-output-provenance',
        owner: 'permission_enforcement',
        risk: 'Derived outputs can combine inputs with incompatible policy sets.',
        requirement:
          'Block empty intersections, store derived visibility metadata, and require write permission on the resolved target policy.',
      },
      {
        id: 'reranker-and-model-egress',
        owner: 'permission_enforcement',
        risk: 'Reranker, expansion, extraction, and synthesis prompts may receive unreadable text if filtering happens too late.',
        requirement:
          'Filter before any external model call and treat model payload construction as an enforcement boundary.',
      },
      {
        id: 'audit-reconstruction',
        owner: 'audit_hardening',
        risk: 'Request-context ids are inspectable but not durably sufficient to reconstruct every hosted read/write/derivation.',
        requirement:
          'Audit hardening must add append-only audit rows after permission-enforcement decisions exist.',
      },
    ],
    secure_claim_blockers: [
      'No secure multi-user claim until every p0 and p1 hook above is implemented and tested.',
      'No hosted write claim until write authorization and derived-output policy storage are enforced.',
      'No policy-safe retrieval claim until search, graph, reranker, cache, facts, takes, and analytics reads filter before exposure.',
      'No direct database credential path for normal secure users without matching DB-level enforcement.',
    ],
  };
}
