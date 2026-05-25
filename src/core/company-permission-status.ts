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
        'direct database credentials stay admin/development only',
      ],
      out_of_scope: [
        'database-level ACL or RLS enforcement',
        'durable append-only policy audit',
        'policy-safe query cache reuse',
        'broad hosted skills, external execution, or external research/model egress',
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
    ],
    unsupported_claims: [
      {
        id: 'database-acl-rls',
        status: 'not_claimed',
        reason: 'Application filters do not protect callers with direct SQL access.',
        requirement: 'Add matching database-level ACL/RLS before issuing direct database credentials to normal users.',
      },
      {
        id: 'durable-audit',
        status: 'not_claimed',
        reason: 'Request and policy decisions are not yet stored in an append-only audit log.',
        requirement: 'Add durable audit rows with hash chaining and permissioned audit-log reads.',
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
        id: 'durable-audit-deferred',
        owner: 'audit_hardening',
        risk: 'A hosted read, write, or denial cannot yet be reconstructed from append-only policy audit rows.',
        current_control: 'Request-context policy decision ids are attached to in-process decisions and hosted writes.',
        requirement: 'Persist append-only audit events for hosted tool lists, calls, denials, reads, writes, and derived writes.',
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
        id: 'external-and-analytics-surfaces-disabled',
        owner: 'permission_enforcement',
        risk: 'Disabled analytics, maintenance, external egress, and job/subagent surfaces are not covered by the narrow claim.',
        current_control: 'Hosted company tool listing and direct-call gates deny those surfaces.',
        requirement: 'Keep denied until each surface has policy filters and audit coverage.',
      },
      {
        id: 'oauth-postgres-e2e',
        owner: 'integration_verification',
        risk: 'Connector, OAuth, and Postgres deployment wiring can drift from PGLite dispatch behavior.',
        current_control: 'Shared dispatch and SQL parity are covered by unit/integration tests where available.',
        requirement: 'Run live hosted OAuth MCP and Postgres checks in the target deployment environment.',
      },
    ],
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
        'Normal users should use hosted MCP; direct database credentials remain admin/development only.',
        'Policy-scoped hosted retrieval keeps semantic query cache disabled.',
      ],
      not_allowed: [
        'Do not claim database-level ACL/RLS enforcement.',
        'Do not claim durable append-only audit until audit hardening lands.',
        'Do not claim broad hosted skills, external execution, analytics aggregates, or policy-safe cache reuse.',
      ],
    },
  };
}
