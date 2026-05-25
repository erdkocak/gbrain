import { describe, expect, test } from 'bun:test';
import {
  COMPANY_PERMISSION_STATUS_KIND,
  buildCompanyPermissionStatus,
} from '../src/core/company-permission-status.ts';

const INTERNAL_PLANNING_LABELS = new RegExp([
  '\\b' + 'stage' + '\\b',
  'stage' + '[_ -]?[0-9]',
  'stage' + '3',
  'stage' + '-3',
  'stage' + '_3',
  'stage' + '_4',
].join('|'), 'i');

describe('company permission status', () => {
  test('records the narrow hosted claim, residual risks, and audit handoff', () => {
    const status = buildCompanyPermissionStatus();

    expect(status.kind).toBe(COMPANY_PERMISSION_STATUS_KIND);
    expect(status.claim_status).toBe('narrow_app_layer_claim_supported');
    expect(status.claim).toContain('Reviewed hosted MCP operations');
    expect(status.proof_scope.protected_path).toBe('hosted_mcp_reviewed_operations');
    expect(status.proof_scope.enforcement_layer).toBe('application_operation_layer');
    expect(status.proof_scope.out_of_scope).toContain('database-level ACL or RLS enforcement');
    expect(status.supported_claims.map((claim) => claim.id)).toEqual([
      'request-context-and-tool-gate',
      'direct-read-filtering',
      'retrieval-rerank-cache',
      'writes-and-derived-visibility',
      'graph-and-code-traversal',
    ]);
    expect(status.unsupported_claims.map((claim) => claim.id)).toContain('database-acl-rls');
    expect(status.unsupported_claims.map((claim) => claim.id)).toContain('durable-audit');
    expect(status.residual_risks.map((risk) => risk.id)).toContain('direct-db-credentials-admin-only');
    expect(status.residual_risks.map((risk) => risk.id)).toContain('missing-object-policy-metadata');
    expect(status.audit_handoff.event_types).toContain('company.hosted.policy_decision');
    expect(status.audit_handoff.minimum_event_shape.required_fields).toContain('policy_decision_id');
    expect(status.audit_handoff.minimum_event_shape.required_fields).toContain('object_ids_or_slugs');
    expect(status.audit_handoff.result_capture).toEqual({
      result_count: true,
      object_ids_or_slugs: true,
      content: 'hash_only',
    });
    expect(status.audit_handoff.failure_mode.default).toBe('fail_closed_for_hosted_company_operations');
    expect(status.public_wording.not_allowed.join('\n')).toContain('database-level ACL/RLS');
    expect(JSON.stringify(status)).not.toMatch(INTERNAL_PLANNING_LABELS);
  });
});
