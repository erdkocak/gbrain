import type { BrainEngine } from './engine.ts';
import {
  buildCompanyHostedSurfaceConfig,
  type CompanyHostedSurfaceConfig,
} from './company-hosted-surface.ts';
import {
  COMPANY_PRIMARY_SOURCE_ID,
  COMPANY_MODE_KIND,
  COMPANY_TRUST_MODE,
} from './company-mode.ts';
import {
  type CompanyPolicyMetadata,
  type CompanyPolicySeed,
  type CompanyPolicyStorage,
} from './company-policy.ts';
import {
  evaluateCompanyPolicyForUser,
  type CompanyPolicyUserEvaluation,
} from './company-policy-evaluator.ts';
import {
  buildCompanyRequestContext,
  loadCompanyPolicyConfigSnapshot,
  type CompanyIdentityInput,
  type CompanyRequestContext,
} from './company-request-context.ts';
import {
  buildCompanyObjectPolicyConfig,
  type CompanyObjectPolicyConfig,
} from './company-object-policy.ts';
import type { AuthInfo } from './operations.ts';

export const COMPANY_POLICY_INSPECTION_KIND = 'company_policy_inspection';
export const COMPANY_POLICY_INSPECTION_GUARDRAIL =
  'Policies are represented and resolvable, but not yet fully enforced.';

export class CompanyPolicyInspectError extends Error {
  constructor(
    public code:
      | 'company_mode_required'
      | 'source_missing'
      | 'policy_missing'
      | 'invalid_config'
      | 'user_required'
      | 'identity_required',
    message: string,
  ) {
    super(message);
    this.name = 'CompanyPolicyInspectError';
  }
}

export interface CompanyPolicyStorageSummary {
  schema_version: CompanyPolicyStorage['schema_version'];
  kind: CompanyPolicyStorage['kind'];
  enforcement: CompanyPolicyStorage['enforcement'];
  default_decision: CompanyPolicyStorage['default_decision'];
  default_policy_id: CompanyPolicyStorage['default_policy_id'];
  users: number;
  active_users: number;
  groups: number;
  policies: number;
  grants: number;
  path_defaults: number;
}

export interface CompanyPolicyInspectionSurfaceSummary {
  hosted_surface_mode: CompanyHostedSurfaceConfig['mode'];
  hosted_skill_default: CompanyHostedSurfaceConfig['skill_gate']['default'];
  hosted_skill_exposure: CompanyHostedSurfaceConfig['skill_gate']['exposure'];
  disabled_surfaces: CompanyHostedSurfaceConfig['disabled_surfaces'];
  object_policy_kind: CompanyObjectPolicyConfig['kind'];
  object_policy_enforcement: CompanyObjectPolicyConfig['enforcement'];
}

export interface CompanyPolicySeedInspection {
  schema_version: 1;
  kind: typeof COMPANY_POLICY_INSPECTION_KIND;
  guardrail: typeof COMPANY_POLICY_INSPECTION_GUARDRAIL;
  source_id: string;
  trusted_workspace: true;
  policy_seed: CompanyPolicySeed | null;
  policy_metadata: CompanyPolicyMetadata | null;
  policy_storage: CompanyPolicyStorageSummary;
  hosted_surface: CompanyHostedSurfaceConfig;
  object_policy: CompanyObjectPolicyConfig;
  surface_summary: CompanyPolicyInspectionSurfaceSummary;
}

export interface CompanyPolicyGrantInspection {
  schema_version: 1;
  kind: typeof COMPANY_POLICY_INSPECTION_KIND;
  guardrail: typeof COMPANY_POLICY_INSPECTION_GUARDRAIL;
  source_id: string;
  trusted_workspace: true;
  user_id: string;
  effective_grants: CompanyPolicyUserEvaluation;
  policy_metadata: CompanyPolicyMetadata | null;
  policy_storage: CompanyPolicyStorageSummary;
  surface_summary: CompanyPolicyInspectionSurfaceSummary;
}

export interface CompanyRequestContextPreviewInput {
  sourceId?: string;
  requestId?: string;
  sessionId?: string;
  remote?: boolean;
  allowedSources?: string[];
  identity: CompanyIdentityInput;
}

export interface CompanyRequestContextPreview {
  schema_version: 1;
  kind: typeof COMPANY_POLICY_INSPECTION_KIND;
  guardrail: typeof COMPANY_POLICY_INSPECTION_GUARDRAIL;
  source_id: string;
  trusted_workspace: true;
  request_context: CompanyRequestContext;
  policy_storage: CompanyPolicyStorageSummary;
  surface_summary: CompanyPolicyInspectionSurfaceSummary;
}

interface CompanyPolicyInspectionWorkspace {
  sourceId: string;
  storage: CompanyPolicyStorage;
  metadata: CompanyPolicyMetadata | undefined;
  seed: CompanyPolicySeed | null;
  hostedSurface: CompanyHostedSurfaceConfig;
  objectPolicy: CompanyObjectPolicyConfig;
}

export async function inspectCompanyPolicySeed(
  engine: BrainEngine,
  input: { sourceId?: string } = {},
): Promise<CompanyPolicySeedInspection> {
  const workspace = await loadCompanyPolicyInspectionWorkspace(engine, input.sourceId);
  return {
    schema_version: 1,
    kind: COMPANY_POLICY_INSPECTION_KIND,
    guardrail: COMPANY_POLICY_INSPECTION_GUARDRAIL,
    source_id: workspace.sourceId,
    trusted_workspace: true,
    policy_seed: workspace.seed,
    policy_metadata: workspace.metadata ?? null,
    policy_storage: summarizePolicyStorage(workspace.storage),
    hosted_surface: workspace.hostedSurface,
    object_policy: workspace.objectPolicy,
    surface_summary: summarizeInspectionSurface(workspace.hostedSurface, workspace.objectPolicy),
  };
}

export async function inspectCompanyPolicyGrants(
  engine: BrainEngine,
  input: { userId: string; sourceId?: string },
): Promise<CompanyPolicyGrantInspection> {
  const userId = input.userId.trim();
  if (!userId) {
    throw new CompanyPolicyInspectError('user_required', 'Company policy grant inspection requires a user id.');
  }
  const workspace = await loadCompanyPolicyInspectionWorkspace(engine, input.sourceId);
  const evaluation = evaluateCompanyPolicyForUser(workspace.storage, userId, workspace.metadata);
  return {
    schema_version: 1,
    kind: COMPANY_POLICY_INSPECTION_KIND,
    guardrail: COMPANY_POLICY_INSPECTION_GUARDRAIL,
    source_id: workspace.sourceId,
    trusted_workspace: true,
    user_id: userId,
    effective_grants: evaluation,
    policy_metadata: workspace.metadata ?? null,
    policy_storage: summarizePolicyStorage(workspace.storage),
    surface_summary: summarizeInspectionSurface(workspace.hostedSurface, workspace.objectPolicy),
  };
}

export async function previewCompanyPolicyRequestContext(
  engine: BrainEngine,
  input: CompanyRequestContextPreviewInput,
): Promise<CompanyRequestContextPreview> {
  const identity = normalizeIdentity(input.identity);
  if (!identity.userId && !identity.email && !identity.idpSubject && !identity.clientId && !identity.clientName && input.remote !== false) {
    throw new CompanyPolicyInspectError(
      'identity_required',
      'Company request-context preview requires --user-id, --email, --idp-subject, --client-id, --client-name, or --local.',
    );
  }
  const workspace = await loadCompanyPolicyInspectionWorkspace(engine, input.sourceId);
  const auth = buildPreviewAuth(identity, input.remote ?? true, workspace.sourceId, input.allowedSources);
  const requestContext = buildCompanyRequestContext({
    requestId: input.requestId,
    sourceId: workspace.sourceId,
    allowedSources: input.allowedSources,
    remote: input.remote ?? true,
    auth,
    identity,
    storage: workspace.storage,
    metadata: workspace.metadata,
    trustedWorkspace: true,
    sessionId: input.sessionId,
  });

  return {
    schema_version: 1,
    kind: COMPANY_POLICY_INSPECTION_KIND,
    guardrail: COMPANY_POLICY_INSPECTION_GUARDRAIL,
    source_id: workspace.sourceId,
    trusted_workspace: true,
    request_context: requestContext,
    policy_storage: summarizePolicyStorage(workspace.storage),
    surface_summary: summarizeInspectionSurface(workspace.hostedSurface, workspace.objectPolicy),
  };
}

async function loadCompanyPolicyInspectionWorkspace(
  engine: BrainEngine,
  sourceIdInput?: string,
): Promise<CompanyPolicyInspectionWorkspace> {
  const brainMode = await engine.getConfig('brain.mode');
  const companyMode = await engine.getConfig('company.mode');
  if (brainMode !== COMPANY_MODE_KIND || companyMode !== COMPANY_TRUST_MODE) {
    throw new CompanyPolicyInspectError(
      'company_mode_required',
      'Company policy inspection requires a trusted-workspace company brain. Run `gbrain init --company` first.',
    );
  }

  const sourceId = sourceIdInput
    ?? await engine.getConfig('company.primary_source_id')
    ?? COMPANY_PRIMARY_SOURCE_ID;
  const rows = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM sources WHERE id = $1 AND archived = false`,
    [sourceId],
  );
  if (rows.length === 0) {
    throw new CompanyPolicyInspectError(
      'source_missing',
      `Company source "${sourceId}" is missing. Re-run \`gbrain init --company\` or create the source first.`,
    );
  }

  const snapshot = await loadCompanyPolicyConfigSnapshot(engine);
  if (!snapshot) {
    throw new CompanyPolicyInspectError(
      'policy_missing',
      'Company policy storage is missing. Re-run `gbrain init --company` to seed policy representation.',
    );
  }

  const seed = await getJsonConfig<CompanyPolicySeed>(engine, 'company.policy.seed');
  const hostedSurface = await getJsonConfig<CompanyHostedSurfaceConfig>(engine, 'company.hosted_surface')
    ?? buildCompanyHostedSurfaceConfig();
  const objectPolicy = await getJsonConfig<CompanyObjectPolicyConfig>(engine, 'company.object_policy')
    ?? buildCompanyObjectPolicyConfig(snapshot.storage);

  return {
    sourceId,
    storage: snapshot.storage,
    metadata: snapshot.metadata,
    seed,
    hostedSurface,
    objectPolicy,
  };
}

async function getJsonConfig<T>(engine: BrainEngine, key: string): Promise<T | null> {
  const raw = await engine.getConfig(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    throw new CompanyPolicyInspectError(
      'invalid_config',
      `Company policy inspection could not parse config "${key}": ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function summarizePolicyStorage(storage: CompanyPolicyStorage): CompanyPolicyStorageSummary {
  const users = Object.values(storage.users);
  return {
    schema_version: storage.schema_version,
    kind: storage.kind,
    enforcement: storage.enforcement,
    default_decision: storage.default_decision,
    default_policy_id: storage.default_policy_id,
    users: users.length,
    active_users: users.filter((user) => user.active).length,
    groups: Object.keys(storage.groups).length,
    policies: Object.keys(storage.policies).length,
    grants: storage.grants.length,
    path_defaults: storage.path_defaults.length,
  };
}

function summarizeInspectionSurface(
  hostedSurface: CompanyHostedSurfaceConfig,
  objectPolicy: CompanyObjectPolicyConfig,
): CompanyPolicyInspectionSurfaceSummary {
  return {
    hosted_surface_mode: hostedSurface.mode,
    hosted_skill_default: hostedSurface.skill_gate.default,
    hosted_skill_exposure: hostedSurface.skill_gate.exposure,
    disabled_surfaces: hostedSurface.disabled_surfaces,
    object_policy_kind: objectPolicy.kind,
    object_policy_enforcement: objectPolicy.enforcement,
  };
}

function normalizeIdentity(identity: CompanyIdentityInput): CompanyIdentityInput {
  return {
    userId: normalizeString(identity.userId),
    email: normalizeString(identity.email),
    idpSubject: normalizeString(identity.idpSubject),
    clientId: normalizeString(identity.clientId),
    clientName: normalizeString(identity.clientName),
  };
}

function buildPreviewAuth(
  identity: CompanyIdentityInput,
  remote: boolean,
  sourceId: string,
  allowedSources?: string[],
): AuthInfo | undefined {
  if (!remote || (!identity.clientId && !identity.clientName)) return undefined;
  return {
    token: 'company-policy-preview',
    clientId: identity.clientId ?? 'company-policy-preview-client',
    clientName: identity.clientName ?? undefined,
    companyUserId: identity.userId ?? undefined,
    userEmail: identity.email ?? undefined,
    idpSubject: identity.idpSubject ?? undefined,
    scopes: [],
    sourceId,
    allowedSources,
  };
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
