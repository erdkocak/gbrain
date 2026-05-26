export const COMPANY_PERMISSION_STATUS_KIND = 'company_permission_status';

export type CompanyPermissionClaimStatus = 'narrow_app_layer_claim_supported';
export type CompanyPermissionOwner =
  | 'permission_enforcement'
  | 'audit_hardening'
  | 'database_enforcement'
  | 'operator_boundary'
  | 'integration_verification';

export interface CompanyPermissionClaim {
  id: string;
  status: 'supported';
  claim: string;
  evidence: string[];
}

export interface CompanyUnsupportedClaim {
  id: string;
  status: 'not_claimed';
  reason: string;
  requirement: string;
}

export interface CompanyPermissionResidualRisk {
  id: string;
  owner: CompanyPermissionOwner;
  risk: string;
  current_control: string;
  requirement: string;
}

export interface CompanyAuditHandoff {
  schema_version: 1;
  event_types: string[];
  minimum_event_shape: {
    required_fields: string[];
    content_rule: string;
  };
  policy_decision_fields: string[];
  result_capture: {
    result_count: true;
    object_ids_or_slugs: true;
    content: 'hash_only';
  };
  failure_mode: {
    default: 'fail_closed_for_hosted_company_operations';
    exceptions: string[];
  };
}

export interface CompanyAuditMatrixEntry {
  id: string;
  coverage: string;
  event_types: string[];
  failure_mode: string;
  evidence: string[];
}

export interface CompanyAuditabilityStatus {
  status: 'narrow_hosted_application_audit_supported';
  claim: string;
  matrix: CompanyAuditMatrixEntry[];
  verification: {
    hash_chain: 'application_hash_chain';
    audit_reads: 'local_admin_and_configured_reader_filtered';
    required_append_failure: 'fail_closed_except_named_support_tools';
  };
  limitations: string[];
}

export interface CompanyPermissionStatus {
  schema_version: 1;
  kind: typeof COMPANY_PERMISSION_STATUS_KIND;
  claim_status: CompanyPermissionClaimStatus;
  claim: string;
  proof_scope: {
    protected_path: 'hosted_mcp_reviewed_operations';
    enforcement_layer: 'application_operation_layer';
    required_runtime_conditions: string[];
    out_of_scope: string[];
  };
  supported_claims: CompanyPermissionClaim[];
  unsupported_claims: CompanyUnsupportedClaim[];
  residual_risks: CompanyPermissionResidualRisk[];
  auditability: CompanyAuditabilityStatus;
  audit_handoff: CompanyAuditHandoff;
  public_wording: {
    allowed: string[];
    not_allowed: string[];
  };
}

export function buildCompanyPermissionStatus(): CompanyPermissionStatus {
  return {
    schema_version: 1,
    kind: COMPANY_PERMISSION_STATUS_KIND,
    claim_status: 'narrow_app_layer_claim_supported',
    claim:
      'Reviewed hosted MCP operations enforce application-layer company permissions for resolved company users.',
    proof_scope: {
      protected_path: 'hosted_mcp_reviewed_operations',
      enforcement_layer: 'application_operation_layer',
      required_runtime_conditions: [
        'normal users reach company memory only through hosted MCP operations',
        'company request context resolves one active user and current policy metadata',
        'tools are selected from the reviewed hosted company tool gate',
        'company audit migrations are applied and hosted audit append is available',
        'direct database credentials stay admin/development only',
      ],
      out_of_scope: [
        'database-level ACL or RLS enforcement',
        'enterprise audit guarantees such as signed checkpoints, DB-level immutability, or external audit export',
        'hosted MCP audit-log read tools',
        'complete non-admin audit-reader visibility for opaque numeric object refs',
        'policy-safe query cache reuse',
        'broad hosted skills, external execution, or external research/model egress',
        'live OAuth/Postgres deployment parity',
      ],
    },
    supported_claims: [
      {
        id: 'request-context-and-tool-gate',
        status: 'supported',
        claim:
          'Hosted company calls fail closed without a resolved user, current policy context, allowed source scope, and reviewed tool.',
        evidence: [
          'test/company-request-gate.test.ts',
          'test/company-hosted-tool-gate.test.ts',
          'test/company-permission-regression.test.ts',
        ],
      },
      {
        id: 'direct-read-filtering',
        status: 'supported',
        claim:
          'Reviewed page, chunk, raw-data, ingest-log, fact, take, and trajectory reads hide unreadable objects as missing or empty results.',
        evidence: [
          'test/company-read-filter.test.ts',
          'test/company-permission-regression.test.ts',
        ],
      },
      {
        id: 'retrieval-rerank-cache',
        status: 'supported',
        claim:
          'Keyword, vector, hybrid, two-pass, and reranker retrieval filter before result return, capture, writeback, and reranker payload construction; policy-scoped cache reuse stays disabled.',
        evidence: [
          'test/company-retrieval-filter.test.ts',
          'test/company-cache-safety.test.ts',
          'test/company-permission-regression.test.ts',
        ],
      },
      {
        id: 'writes-and-derived-visibility',
        status: 'supported',
        claim:
          'The reviewed hosted write path requires writable target policies and stores derived visibility metadata; unreviewed write surfaces remain disabled.',
        evidence: [
          'test/company-write-auth.test.ts',
          'test/company-permission-regression.test.ts',
        ],
      },
      {
        id: 'graph-and-code-traversal',
        status: 'supported',
        claim:
          'Reviewed graph, link, and code traversal operations enforce readable seed, frontier, edge, source, and snippet boundaries.',
        evidence: [
          'test/company-graph-filter.test.ts',
          'test/company-permission-regression.test.ts',
        ],
      },
      {
        id: 'hosted-application-auditability',
        status: 'supported',
        claim:
          'Reviewed hosted company operations write hash-chained audit rows for tool listing, tool calls, denials, read results, reviewed writes, and derived-write decisions; required audit append failures fail closed except for the named support tool.',
        evidence: [
          'test/company-audit.test.ts',
          'test/company-audit-dispatch.test.ts',
          'test/company-audit-read-result.test.ts',
          'test/company-audit-write-result.test.ts',
          'test/company-audit-read-access.test.ts',
          'test/company-audit-claim-gate.test.ts',
        ],
      },
    ],
    unsupported_claims: [
      {
        id: 'database-acl-rls',
        status: 'not_claimed',
        reason: 'Application filters do not protect callers with direct SQL access.',
        requirement: 'Add matching database-level ACL/RLS before issuing direct database credentials to normal users.',
      },
      {
        id: 'enterprise-audit-guarantees',
        status: 'not_claimed',
        reason: 'The hosted audit log is application-layer, hash-chained storage, not DB-level immutability, signed checkpointing, or external compliance export.',
        requirement: 'Add DB-level immutability controls, signed checkpoints, export/reconciliation workflows, and deployment procedures before making enterprise audit claims.',
      },
      {
        id: 'hosted-audit-read-mcp',
        status: 'not_claimed',
        reason: 'Audit reads are exposed through local/operator helpers and CLI paths, not a reviewed hosted MCP audit-read tool.',
        requirement: 'Review and allowlist a hosted audit-read tool separately, including reader authorization, output redaction, and side-channel tests.',
      },
      {
        id: 'policy-safe-cache-reuse',
        status: 'not_claimed',
        reason: 'The safe cache posture is disabled-first, not re-enabled with policy-aware keys.',
        requirement: 'Add policy-safe cache keys, stored post-filtered result ids, and invalidation on policy/object changes.',
      },
      {
        id: 'broad-hosted-tools',
        status: 'not_claimed',
        reason: 'Only reviewed hosted tools are exposed; analytics aggregates, external execution, and broad skills remain denied.',
        requirement: 'Review each future tool against read, write, retrieval, cache, graph, and egress boundaries before allowlisting.',
      },
      {
        id: 'live-deployment-parity',
        status: 'not_claimed',
        reason: 'The regression matrix runs against PGLite and shared dispatch paths; live OAuth/Postgres deployment checks remain environment work.',
        requirement: 'Run the same matrix against a deployed OAuth HTTP MCP server backed by Postgres before claiming deployment parity.',
      },
    ],
    residual_risks: [
      {
        id: 'direct-db-credentials-admin-only',
        owner: 'database_enforcement',
        risk: 'Direct SQL access bypasses application-layer permission filters.',
        current_control: 'Normal hosted company users are not offered direct database credentials.',
        requirement: 'Keep that boundary, or add DB-level enforcement that matches application policy.',
      },
      {
        id: 'audit-signed-checkpoints-deferred',
        owner: 'audit_hardening',
        risk: 'Application hash-chain verification detects ordinary row edits or missing rows, but a privileged actor could rewrite all rows and chain state consistently.',
        current_control: 'Hosted company events are stored in a hash chain and can be verified locally.',
        requirement: 'Add signed checkpoints or external anchoring before claiming tamper-proof audit durability.',
      },
      {
        id: 'audit-reader-opaque-numeric-refs',
        owner: 'audit_hardening',
        risk: 'Audit rows with untyped numeric object refs cannot be shown precisely to non-admin audit readers without risking hidden-id leakage.',
        current_control: 'Permissioned non-admin audit reads fail closed for numeric-ref rows; trusted local admins can inspect all rows.',
        requirement: 'Store type-aware object refs end to end before claiming complete permissioned audit-reader visibility.',
      },
      {
        id: 'hosted-audit-read-tool-unexposed',
        owner: 'audit_hardening',
        risk: 'Normal hosted users cannot inspect audit logs through MCP.',
        current_control: 'Audit reads are local/operator or configured-reader helper/CLI flows only.',
        requirement: 'Add a separately reviewed hosted audit-read operation before exposing audit reads over MCP.',
      },
      {
        id: 'cache-reenable-deferred',
        owner: 'permission_enforcement',
        risk: 'Reusing cached retrieval rows across users can leak unreadable result ids or reranker text.',
        current_control: 'Policy-scoped hosted company retrieval bypasses query cache lookup and writeback.',
        requirement: 'Re-enable only with policy-safe keys and post-filtered stored results.',
      },
      {
        id: 'missing-object-policy-metadata',
        owner: 'permission_enforcement',
        risk: 'Older or malformed pages without visibility metadata are not readable on hosted company paths.',
        current_control: 'Readable checks require matching object policy metadata and otherwise fail closed.',
        requirement: 'Backfill or classify legacy company objects before relying on hosted reads for them.',
      },
      {
        id: 'broad-hosted-tools-disabled',
        owner: 'permission_enforcement',
        risk: 'Analytics, maintenance, publishing, and broad hosted tools are not covered by the narrow claim.',
        current_control: 'Hosted company tool listing and direct-call gates deny those surfaces.',
        requirement: 'Keep denied until each surface has policy filters and audit coverage.',
      },
      {
        id: 'external-execution-disabled',
        owner: 'permission_enforcement',
        risk: 'Email, chat, ticket, webhook, shell, job, subagent, and external-research execution could create unaudited or policy-unsafe side effects if enabled broadly.',
        current_control: 'Hosted company surface denies external execution and follow-up remains draft-only.',
        requirement: 'Review each external execution path against authorization, audit, egress, and user-confirmation requirements before enabling.',
      },
      {
        id: 'live-oauth-postgres-parity',
        owner: 'integration_verification',
        risk: 'Connector, OAuth, and Postgres deployment wiring can drift from PGLite dispatch behavior.',
        current_control: 'Shared dispatch and SQL parity are covered by unit/integration tests where available.',
        requirement: 'Run live hosted OAuth MCP and Postgres checks in the target deployment environment.',
      },
    ],
    auditability: {
      status: 'narrow_hosted_application_audit_supported',
      claim:
        'Reviewed hosted company operations produce application-layer, hash-chained audit rows for control-plane decisions, read results, reviewed writes, derived-write decisions, and denials.',
      matrix: [
        {
          id: 'tool-list',
          coverage: 'Hosted tool listing records caller, source scope, policy metadata, reviewed tool ids, and result count.',
          event_types: ['company.hosted.tool_list'],
          failure_mode: 'required append failure returns an empty hosted tool list',
          evidence: ['test/company-audit-dispatch.test.ts', 'test/company-audit-claim-gate.test.ts'],
        },
        {
          id: 'allowed-tool-call',
          coverage: 'Allowed hosted calls record attempted and final tool-call rows without raw args.',
          event_types: ['company.hosted.tool_call'],
          failure_mode: 'required append failure denies the hosted call',
          evidence: ['test/company-audit-dispatch.test.ts', 'test/company-audit-claim-gate.test.ts'],
        },
        {
          id: 'denied-tool-call',
          coverage: 'Request-gate, stale-policy, local-only, write-gate, hosted-tool-gate, and unknown-tool denials record redacted denial rows.',
          event_types: ['company.hosted.denial'],
          failure_mode: 'required denial append failure denies the hosted call with the audit failure message',
          evidence: ['test/company-audit-dispatch.test.ts', 'test/company-request-gate.test.ts', 'test/company-audit-claim-gate.test.ts'],
        },
        {
          id: 'direct-read-results',
          coverage: 'Direct hosted reads record post-filtered result count and object refs without raw page bodies or hidden refs.',
          event_types: ['company.hosted.read_result'],
          failure_mode: 'read-result append failure denies the hosted read before returning content',
          evidence: ['test/company-audit-read-result.test.ts', 'test/company-audit-claim-gate.test.ts'],
        },
        {
          id: 'retrieval-results',
          coverage: 'Hosted retrieval records post-filtered result count, object refs, and query hash only.',
          event_types: ['company.hosted.read_result'],
          failure_mode: 'read-result append failure denies the hosted retrieval before returning content',
          evidence: ['test/company-audit-read-result.test.ts', 'test/company-audit-claim-gate.test.ts'],
        },
        {
          id: 'graph-code-traversal',
          coverage: 'Hosted graph, link, and code traversal audit records post-filtered ids/slugs without snippets or symbol payloads.',
          event_types: ['company.hosted.read_result'],
          failure_mode: 'read-result append failure denies the hosted traversal before returning content',
          evidence: ['test/company-audit-read-result.test.ts', 'test/company-audit-claim-gate.test.ts'],
        },
        {
          id: 'writes',
          coverage: 'Reviewed hosted writes record attempted, denied, and successful write-result rows with content hashes and target refs.',
          event_types: ['company.hosted.write_result'],
          failure_mode: 'required pre-commit or success append failure prevents committed writes',
          evidence: ['test/company-audit-write-result.test.ts', 'test/company-audit-claim-gate.test.ts'],
        },
        {
          id: 'derived-writes',
          coverage: 'Derived visibility decisions record inherited, intersected, and rejected derived-write rows without raw content.',
          event_types: ['company.hosted.derived_write'],
          failure_mode: 'derived-write status follows enclosing write completion',
          evidence: ['test/company-audit-write-result.test.ts', 'test/company-audit-claim-gate.test.ts'],
        },
        {
          id: 'audit-read-and-verify',
          coverage: 'Local/operator and configured-reader audit inspection redacts raw payloads and denial details; verification checks row hashes and chain continuity.',
          event_types: ['company_audit_read', 'company_audit_verification'],
          failure_mode: 'non-admin audit reads fail closed for opaque numeric refs',
          evidence: ['test/company-audit-read-access.test.ts'],
        },
      ],
      verification: {
        hash_chain: 'application_hash_chain',
        audit_reads: 'local_admin_and_configured_reader_filtered',
        required_append_failure: 'fail_closed_except_named_support_tools',
      },
      limitations: [
        'not database-level ACL/RLS or direct-SQL protection',
        'not signed checkpointing, external anchoring, or enterprise audit export',
        'not live OAuth/Postgres deployment parity',
        'not hosted MCP audit-read exposure',
        'not complete non-admin visibility for opaque numeric audit refs',
      ],
    },
    audit_handoff: {
      schema_version: 1,
      event_types: [
        'company.hosted.tool_list',
        'company.hosted.tool_call',
        'company.hosted.policy_decision',
        'company.hosted.read_result',
        'company.hosted.write_result',
        'company.hosted.derived_write',
        'company.hosted.denial',
      ],
      minimum_event_shape: {
        required_fields: [
          'event_id',
          'event_type',
          'timestamp',
          'request_id',
          'session_id',
          'user_id',
          'client_id',
          'client_name',
          'transport',
          'operation',
          'source_scope',
          'policy_decision_id',
          'policy_version',
          'policy_hash',
          'readable_policy_ids_hash',
          'writable_policy_ids_hash',
          'args_hash',
          'content_or_query_hash',
          'result_count',
          'object_ids_or_slugs',
          'status',
          'denial_reason',
          'previous_event_hash',
          'event_hash',
        ],
        content_rule:
          'Store hashes, ids, counts, and policy metadata; do not store page body, chunk text, prompts, file bytes, or raw query content in audit rows.',
      },
      policy_decision_fields: [
        'policy_decision_id',
        'policy_version',
        'policy_hash',
        'identity_status',
        'identity_source',
        'group_ids_hash',
        'readable_policy_ids_hash',
        'writable_policy_ids_hash',
        'source_scope',
        'decision',
        'reason',
      ],
      result_capture: {
        result_count: true,
        object_ids_or_slugs: true,
        content: 'hash_only',
      },
      failure_mode: {
        default: 'fail_closed_for_hosted_company_operations',
        exceptions: ['whoami may remain best-effort because it returns no brain object content'],
      },
    },
    public_wording: {
      allowed: [
        'Reviewed hosted MCP operations enforce application-layer company permissions for resolved users.',
        'Reviewed hosted company operations write application-layer, hash-chained audit rows for tool listing, calls, denials, read results, reviewed writes, and derived-write decisions.',
        'Required hosted audit append failures fail closed except for the named support tool that returns no brain object content.',
        'Local/operator audit reads and configured audit-reader previews exclude raw args, body, query, prompt, and file payloads.',
        'Normal users should use hosted MCP; direct database credentials remain admin/development only.',
        'Policy-scoped hosted retrieval keeps semantic query cache disabled.',
      ],
      not_allowed: [
        'Do not claim database-level ACL/RLS enforcement.',
        'Do not claim enterprise audit guarantees, DB-level immutability, signed checkpoints, or external audit export.',
        'Do not claim complete non-admin audit-reader visibility for opaque numeric object refs.',
        'Do not claim hosted audit-read MCP exposure, broad hosted skills, external execution, analytics aggregates, policy-safe cache reuse, or live OAuth/Postgres parity.',
      ],
    },
  };
}
