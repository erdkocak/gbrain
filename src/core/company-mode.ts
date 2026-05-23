import type { BrainEngine } from './engine.ts';

export const COMPANY_PRIMARY_SOURCE_ID = 'company';
export const COMPANY_MODE_KIND = 'company';
export const COMPANY_TRUST_MODE = 'trusted_workspace';
export const COMPANY_POLICY_ENFORCEMENT = 'deferred';
export const COMPANY_HOSTED_SKILL_EXPOSURE = 'not_enabled';

export const COMPANY_METADATA_PLACEHOLDER_FIELDS = [
  'visibility_policy_id',
  'created_by',
  'derived_from',
  'evidence_refs',
] as const;

export type CompanyMetadataPlaceholderField =
  typeof COMPANY_METADATA_PLACEHOLDER_FIELDS[number];

export interface CompanyModeConfig {
  kind: typeof COMPANY_MODE_KIND;
  mode: typeof COMPANY_TRUST_MODE;
  trusted_workspace: true;
  primary_source_id: string;
  policy_enforcement: typeof COMPANY_POLICY_ENFORCEMENT;
  security_claim: 'none_trusted_workspace_only';
  metadata_placeholders: {
    visibility_policy_id: null;
    created_by: null;
    derived_from: unknown[];
    evidence_refs: unknown[];
  };
  hosted_skill_exposure: typeof COMPANY_HOSTED_SKILL_EXPOSURE;
}

export function buildCompanyModeConfig(
  primarySourceId = COMPANY_PRIMARY_SOURCE_ID,
): CompanyModeConfig {
  return {
    kind: COMPANY_MODE_KIND,
    mode: COMPANY_TRUST_MODE,
    trusted_workspace: true,
    primary_source_id: primarySourceId,
    policy_enforcement: COMPANY_POLICY_ENFORCEMENT,
    security_claim: 'none_trusted_workspace_only',
    metadata_placeholders: {
      visibility_policy_id: null,
      created_by: null,
      derived_from: [],
      evidence_refs: [],
    },
    hosted_skill_exposure: COMPANY_HOSTED_SKILL_EXPOSURE,
  };
}

export async function applyCompanyModeSkeleton(
  engine: BrainEngine,
  primarySourceId = COMPANY_PRIMARY_SOURCE_ID,
): Promise<CompanyModeConfig> {
  const config = buildCompanyModeConfig(primarySourceId);
  const sourceConfig = {
    federated: true,
    company_primary: true,
    trusted_workspace: true,
    policy_enforcement: COMPANY_POLICY_ENFORCEMENT,
    metadata_placeholders: COMPANY_METADATA_PLACEHOLDER_FIELDS,
  };

  await engine.executeRaw(
    `INSERT INTO sources (id, name, config)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         config = sources.config || EXCLUDED.config,
         archived = false,
         archived_at = NULL,
         archive_expires_at = NULL`,
    [primarySourceId, primarySourceId, JSON.stringify(sourceConfig)],
  );

  await engine.setConfig('brain.mode', COMPANY_MODE_KIND);
  await engine.setConfig('company.mode', COMPANY_TRUST_MODE);
  await engine.setConfig('company.trusted_workspace', 'true');
  await engine.setConfig('company.primary_source_id', primarySourceId);
  await engine.setConfig('company.policy_enforcement', COMPANY_POLICY_ENFORCEMENT);
  await engine.setConfig('company.security_claim', config.security_claim);
  await engine.setConfig(
    'company.metadata_placeholders',
    JSON.stringify(COMPANY_METADATA_PLACEHOLDER_FIELDS),
  );
  await engine.setConfig('company.hosted_skill_exposure', COMPANY_HOSTED_SKILL_EXPOSURE);
  await engine.setConfig('sources.default', primarySourceId);

  return config;
}
