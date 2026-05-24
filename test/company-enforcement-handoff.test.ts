import { describe, expect, test } from 'bun:test';
import {
  buildCompanyEnforcementHandoff,
  COMPANY_ENFORCEMENT_HANDOFF_GUARDRAIL,
  COMPANY_ENFORCEMENT_HANDOFF_KIND,
} from '../src/core/company-enforcement-handoff.ts';

const INTERNAL_PLANNING_LABELS = new RegExp([
  '\\b' + 'stage' + '\\b',
  'stage' + '[_ -]?[0-9]',
  'stage' + '3',
  'stage' + '-3',
  'stage' + '_3',
  'stage' + '_4',
].join('|'), 'i');

describe('company enforcement handoff', () => {
  test('records cache, graph, derived-memory, and hook order without enforcement claims', () => {
    const handoff = buildCompanyEnforcementHandoff();

    expect(handoff.kind).toBe(COMPANY_ENFORCEMENT_HANDOFF_KIND);
    expect(handoff.guardrail).toBe(COMPANY_ENFORCEMENT_HANDOFF_GUARDRAIL);
    expect(handoff.guardrail).toContain('not yet fully enforced');
    expect(handoff.cache_strategy.decision).toBe('disable_company_secure_cache_until_policy_safe_keys');
    expect(handoff.cache_strategy.policy_safe_key_plan.required_fields).toContain('policy_hash');
    expect(handoff.cache_strategy.policy_safe_key_plan.required_fields).toContain('readable_policy_ids_hash');
    expect(handoff.graph_traversal_plan.required_checks).toContain('Return an edge only when both endpoints are readable.');

    const derivedSurfaces = handoff.derived_memory_plan.map((entry) => entry.surface);
    expect(derivedSurfaces).toContain('company decisions and commitments');
    expect(derivedSurfaces).toContain('facts and hot memory');
    expect(derivedSurfaces).toContain('dream-cycle synthesis, patterns, and consolidation');

    const hookIds = handoff.first_hooks.map((hook) => hook.id);
    expect(hookIds.slice(0, 5)).toEqual([
      'request-context-required',
      'direct-read-filter',
      'write-authorization',
      'search-before-rerank',
      'cache-disabled-then-keyed',
    ]);
    expect(hookIds).toContain('graph-filter');
    expect(hookIds).toContain('skill-gate');
    expect(handoff.first_hooks.filter((hook) => hook.priority === 'p0').every((hook) => hook.blocks_secure_claim_until_done)).toBe(true);
    expect(handoff.residual_risks.map((risk) => risk.owner)).toContain('audit_hardening');
    expect(handoff.secure_claim_blockers.join('\n')).toContain('No secure multi-user claim');
    expect(JSON.stringify(handoff)).not.toMatch(INTERNAL_PLANNING_LABELS);
  });
});
