import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mintMinionToken, type PendingApproval } from 'framework-core';
import { createMemoryStore } from '../store.js';
import {
  createMemoryEffectStore,
  createSqliteEffectStore,
  draftRef,
  newDraftId,
  parseDraftRef,
  toAuditView,
  toDecisionRecord,
  type EffectDraftRecord,
} from '../effect-store.js';
import {
  APPROVAL_CLASSES,
  COMMIT_EFFECT,
  DISCARD_EFFECT,
  DRAFT_EFFECT,
  EffectCredentials,
  EffectGateway,
  ensureEffectGatewayRules,
  effectTypesFromRecord,
  makeEffectTypePolicy,
  MapVerificationResolver,
  RecordingConnector,
  requiresHumanActor,
  SERVER_ALIAS,
  type ApprovalEvidenceView,
  type EffectCaller,
  type EffectTypePolicy,
} from '../effect-gateway.js';
import type { GovernanceConfig } from '../config.js';

const SECRET = 'test-signing-secret';
const RUN_ID = 'run_1';
const CORR = 'corr_20260828';

function effectTypes(): Map<string, EffectTypePolicy> {
  return effectTypesFromRecord({
    'crm.case_note.append': { reversibility: 'reversible', approval_class: 'auto' },
    'payment.refund': { reversibility: 'compensatable', approval_class: 'sampled' },
    'comms.email.send': { reversibility: 'irreversible', approval_class: 'always_human' },
  });
}

interface World {
  gateway: EffectGateway;
  connectors: Map<string, RecordingConnector>;
  approvalStore: ReturnType<typeof createMemoryStore>;
  audits: Array<{ kind: string; status: string; effectType: string }>;
  notified: Array<{ approval: PendingApproval; evidence: ApprovalEvidenceView }>;
  clock: { value: number };
  committerToken: string;
}

function makeWorld(overrides: Partial<Parameters<typeof buildGateway>[0]> = {}): World {
  return buildGateway(overrides);
}

function buildGateway(overrides: {
  signingSecret?: string;
  sampler?: (r: EffectDraftRecord) => boolean;
  approvalNotifier?: (a: PendingApproval, e: ApprovalEvidenceView) => Promise<void>;
} = {}): World {
  const clock = { value: 1_000_000 };
  const now = () => clock.value;
  const connectors = new Map<string, RecordingConnector>([
    ['crm', new RecordingConnector('crm')],
    ['payments', new RecordingConnector('payments')],
    ['email', new RecordingConnector('email')],
  ]);
  const approvalStore = createMemoryStore(now);
  const audits: World['audits'] = [];
  const notified: World['notified'] = [];
  const resolver = new MapVerificationResolver({
    'verify://ok': { ref: 'verify://ok', verifier: 'pytest', passed: true, failing: [] },
    'verify://bad': { ref: 'verify://bad', verifier: 'pytest', passed: false, failing: ['t1'] },
  });
  const gateway = new EffectGateway({
    effectTypes: effectTypes(),
    connectors: connectors as unknown as Map<string, RecordingConnector>,
    credentials: new EffectCredentials({ crm: 'CRM_KEY', email: 'EMAIL_KEY', payments: 'PAY_KEY' }),
    approvalStore,
    signingSecret: overrides.signingSecret ?? SECRET,
    evidenceResolver: resolver,
    approvalNotifier:
      overrides.approvalNotifier ??
      (async (approval, evidence) => {
        notified.push({ approval, evidence });
      }),
    sampler: overrides.sampler,
    auditLogger: (event) => audits.push({ kind: event.kind, status: event.status, effectType: event.effectType }),
    now,
  });
  return { gateway, connectors, approvalStore, audits, notified, clock, committerToken: mintToken('committer') };
}

function mintToken(agentId: string, scopeId: string = RUN_ID, correlationId: string = CORR): string {
  return mintMinionToken({ agent_id: agentId, scope_id: scopeId, correlation_id: correlationId }, SECRET);
}

function committer(token?: string): EffectCaller {
  return { agentId: 'committer', identityToken: token ?? mintToken('committer'), scopeId: RUN_ID, correlationId: CORR };
}

function crmDraftParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    effect_type: 'crm.case_note.append',
    target_system: 'crm',
    payload: { case_id: '5001', note: 'refund issued' },
    evidence: ['verify://ok'],
    reversibility: 'reversible',
    idempotency_key: 'fx_run_1_casenote',
    ...overrides,
  };
}

function emailDraftParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    effect_type: 'comms.email.send',
    target_system: 'email',
    payload: { to: 'c@example.com', template: 'refund_v2' },
    evidence: ['verify://ok'],
    reversibility: 'irreversible',
    idempotency_key: 'fx_run_1_email',
    ...overrides,
  };
}

async function draftAs(w: World, caller: EffectCaller, params: Record<string, unknown>): Promise<string> {
  const result = await w.gateway.draftEffect(params, caller);
  if (!result.drafted || !result.draftRef) {
    throw new Error(`expected draft, got ${JSON.stringify(result)}`);
  }
  return result.draftRef;
}

function noExecutions(w: World): boolean {
  return Array.from(w.connectors.values()).every((c) => c.executions.length === 0);
}

// ---------------------------------------------------------------------------
// draft_effect
// ---------------------------------------------------------------------------

describe('draft_effect', () => {
  it('drafts a conformant, inert effect and executes nothing', async () => {
    const w = makeWorld();
    const result = await w.gateway.draftEffect(crmDraftParams(), committer());
    expect(result.drafted).toBe(true);
    expect(result.reversibility).toBe('reversible');
    expect(result.approvalClass).toBe('auto');
    expect(result.draftRef?.startsWith('draft://')).toBe(true);
    expect(noExecutions(w)).toBe(true);
    expect(w.audits).toContainEqual({ kind: 'effect_draft', status: 'draft', effectType: 'crm.case_note.append' });
  });

  it('records the drafter as verified when a valid token is presented', async () => {
    const w = makeWorld();
    const ref = await draftAs(w, committer(), crmDraftParams());
    const record = (w.gateway as unknown as { store: ReturnType<typeof createMemoryEffectStore> }).store.getDraft(
      parseDraftRef(ref)
    );
    expect(record?.drafterVerified).toBe(true);
    expect(record?.drafterAgentId).toBe('committer');
  });

  it('drafts without a token but records it as unverified (inert but honest)', async () => {
    const w = makeWorld();
    const result = await w.gateway.draftEffect(crmDraftParams(), { agentId: 'anon' });
    expect(result.drafted).toBe(true);
    const record = (w.gateway as unknown as { store: ReturnType<typeof createMemoryEffectStore> }).store.getDraft(
      parseDraftRef(result.draftRef!)
    );
    expect(record?.drafterVerified).toBe(false);
    expect(record?.drafterAgentId).toBe('anon');
  });

  it('does not mark verified when the token is for a different agent', async () => {
    const w = makeWorld();
    const result = await w.gateway.draftEffect(crmDraftParams(), {
      agentId: 'committer',
      identityToken: mintToken('someone_else'),
    });
    const record = (w.gateway as unknown as { store: ReturnType<typeof createMemoryEffectStore> }).store.getDraft(
      parseDraftRef(result.draftRef!)
    );
    expect(record?.drafterVerified).toBe(false);
  });

  it('drafts with no caller at all', async () => {
    const w = makeWorld();
    const result = await w.gateway.draftEffect(crmDraftParams());
    expect(result.drafted).toBe(true);
  });

  it('refuses non-object params', async () => {
    const w = makeWorld();
    expect((await w.gateway.draftEffect('nope')).refused).toBe('draft parameters must be a JSON object');
    expect((await w.gateway.draftEffect(null)).refused).toBe('draft parameters must be a JSON object');
    expect((await w.gateway.draftEffect(['a'])).refused).toBe('draft parameters must be a JSON object');
  });

  it('refuses smuggled fields', async () => {
    const w = makeWorld();
    const result = await w.gateway.draftEffect(
      crmDraftParams({ actor: { kind: 'human' }, approver_id: 'x', token: 't' }),
      committer()
    );
    expect(result.drafted).toBe(false);
    expect(result.refused).toContain('unknown draft fields: actor, approver_id, token');
    expect(noExecutions(w)).toBe(true);
  });

  it('refuses empty required strings', async () => {
    const w = makeWorld();
    expect((await w.gateway.draftEffect(crmDraftParams({ effect_type: '' }))).refused).toBe(
      "'effect_type' must be a non-empty string"
    );
    expect((await w.gateway.draftEffect(crmDraftParams({ target_system: 42 }))).refused).toBe(
      "'target_system' must be a non-empty string"
    );
  });

  it('refuses an ungoverned effect type', async () => {
    const w = makeWorld();
    const result = await w.gateway.draftEffect(
      crmDraftParams({ effect_type: 'nuke.launch', reversibility: 'irreversible' })
    );
    expect(result.refused).toContain('has no governance policy');
  });

  it('refuses a reversibility that disagrees with the policy', async () => {
    const w = makeWorld();
    const result = await w.gateway.draftEffect(crmDraftParams({ reversibility: 'irreversible' }));
    expect(result.refused).toBe(
      "reversibility 'irreversible' disagrees with the declared class 'reversible' for effect type 'crm.case_note.append'"
    );
  });

  it('refuses a non-object payload', async () => {
    const w = makeWorld();
    expect((await w.gateway.draftEffect(crmDraftParams({ payload: 'x' }))).refused).toBe("'payload' must be a JSON object");
    expect((await w.gateway.draftEffect(crmDraftParams({ payload: [1] }))).refused).toBe("'payload' must be a JSON object");
  });

  it('requires an evidence key but accepts an empty array', async () => {
    const w = makeWorld();
    const params = crmDraftParams();
    delete (params as Record<string, unknown>).evidence;
    expect((await w.gateway.draftEffect(params)).refused).toContain("'evidence' is required");
    expect((await w.gateway.draftEffect(crmDraftParams({ evidence: [''] }))).refused).toBe(
      "'evidence' must be an array of non-empty strings"
    );
    expect((await w.gateway.draftEffect(crmDraftParams({ evidence: 'x' }))).refused).toBe(
      "'evidence' must be an array of non-empty strings"
    );
    const empty = await w.gateway.draftEffect(crmDraftParams({ evidence: [] }), committer());
    expect(empty.drafted).toBe(true);
  });

  it('validates the expiry bounds', async () => {
    const w = makeWorld();
    const past = crmDraftParams({ expiry: w.clock.value - 1 });
    expect((await w.gateway.draftEffect(past)).refused).toBe("'expiry' must be in the future");
    const tooFar = crmDraftParams({ expiry: w.clock.value + 8 * 24 * 60 * 60 * 1000 });
    expect((await w.gateway.draftEffect(tooFar)).refused).toContain('seven days');
    const notInt = crmDraftParams({ expiry: 1.5 });
    expect((await w.gateway.draftEffect(notInt)).refused).toBe("'expiry' must be an integer (epoch milliseconds)");
    const good = crmDraftParams({ expiry: w.clock.value + 1000 });
    expect((await w.gateway.draftEffect(good, committer())).drafted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// commit_effect — evidence gate
// ---------------------------------------------------------------------------

describe('commit_effect evidence gate', () => {
  it('commits with passing evidence and an agent actor', async () => {
    const w = makeWorld();
    const ref = await draftAs(w, committer(), crmDraftParams());
    const result = await w.gateway.commitEffect({ draft_ref: ref }, committer());
    expect(result.committed).toBe(true);
    expect(result.idempotentReplay).toBe(false);
    expect(result.decision?.actor).toEqual({
      kind: 'agent',
      token_payload: expect.objectContaining({ agent_id: 'committer', scope_id: RUN_ID }),
    });
    expect(w.connectors.get('crm')!.executions).toHaveLength(1);
    expect(w.audits).toContainEqual({ kind: 'effect_commit', status: 'committed', effectType: 'crm.case_note.append' });
  });

  it('refuses a commit with no passing evidence', async () => {
    const w = makeWorld();
    const ref = await draftAs(w, committer(), crmDraftParams({ evidence: [] }));
    const result = await w.gateway.commitEffect({ draft_ref: ref }, committer());
    expect(result.committed).toBe(false);
    expect(result.refused).toContain('no passing verification result');
    expect(noExecutions(w)).toBe(true);
  });

  it('a failing verification does not authorise', async () => {
    const w = makeWorld();
    const ref = await draftAs(w, committer(), crmDraftParams({ evidence: ['verify://bad'] }));
    const result = await w.gateway.commitEffect({ draft_ref: ref }, committer());
    expect(result.committed).toBe(false);
    expect(noExecutions(w)).toBe(true);
  });

  it('an unresolvable reference does not authorise', async () => {
    const w = makeWorld();
    const ref = await draftAs(w, committer(), crmDraftParams({ evidence: ['verify://never', 'finding-id'] }));
    const result = await w.gateway.commitEffect({ draft_ref: ref }, committer());
    expect(result.committed).toBe(false);
    expect(noExecutions(w)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// commit_effect — identity (decisive)
// ---------------------------------------------------------------------------

describe('commit_effect identity', () => {
  const cases: Array<{ name: string; caller: () => EffectCaller | undefined }> = [
    { name: 'no token', caller: () => ({ agentId: 'committer', scopeId: RUN_ID }) },
    { name: 'malformed token', caller: () => ({ agentId: 'committer', identityToken: 'garbage', scopeId: RUN_ID }) },
    {
      name: 'expired token',
      caller: () => ({ agentId: 'committer', identityToken: mintMinionToken({ agent_id: 'committer', scope_id: RUN_ID, correlation_id: CORR }, SECRET, -1), scopeId: RUN_ID }),
    },
    { name: 'wrong agent', caller: () => ({ agentId: 'committer', identityToken: mintToken('impostor'), scopeId: RUN_ID }) },
    { name: 'cross-run replay', caller: () => ({ agentId: 'committer', identityToken: mintToken('committer', 'other_run'), scopeId: RUN_ID }) },
    { name: 'no caller', caller: () => undefined },
  ];

  for (const c of cases) {
    it(`refuses commit regardless of payload: ${c.name}`, async () => {
      const w = makeWorld();
      const ref = await draftAs(w, committer(), crmDraftParams());
      const result = await w.gateway.commitEffect({ draft_ref: ref, actor: { kind: 'human', approver_id: 'smuggled' } }, c.caller());
      expect(result.committed).toBe(false);
      expect(result.refused?.toLowerCase()).toContain('identity');
      expect(noExecutions(w)).toBe(true);
      const record = (w.gateway as unknown as { store: ReturnType<typeof createMemoryEffectStore> }).store.getDraft(
        parseDraftRef(ref)
      );
      expect(record?.status).toBe('draft');
    });
  }

  it('fails closed when no signing secret is configured', async () => {
    const w = makeWorld({ signingSecret: '' });
    const ref = await draftAs(w, { agentId: 'committer' }, crmDraftParams());
    const result = await w.gateway.commitEffect({ draft_ref: ref }, committer());
    expect(result.refused).toContain('identity verification is not configured');
  });

  it('refuses a commit through the context-less adapter path', async () => {
    const w = makeWorld();
    const ref = await draftAs(w, committer(), crmDraftParams());
    const adapter = w.gateway.adapter();
    const result = (await adapter.callTool(COMMIT_EFFECT, { draft_ref: ref })) as { committed: boolean; refused?: string };
    expect(result.committed).toBe(false);
    expect(result.refused?.toLowerCase()).toContain('identity');
    expect(noExecutions(w)).toBe(true);
  });

  it('discard also requires identity', async () => {
    const w = makeWorld();
    const ref = await draftAs(w, committer(), crmDraftParams());
    const result = await w.gateway.discardEffect({ draft_ref: ref, reason: 'nope' }, { agentId: 'committer' });
    expect(result.discarded).toBe(false);
    expect(result.refused?.toLowerCase()).toContain('identity');
  });
});

// ---------------------------------------------------------------------------
// commit_effect — draft_ref problems
// ---------------------------------------------------------------------------

describe('commit_effect draft loading', () => {
  it('refuses a non-draft reference', async () => {
    const w = makeWorld();
    expect((await w.gateway.commitEffect({ draft_ref: 'nope' }, committer())).refused).toBe(
      "'draft_ref' must be a draft://<id> reference"
    );
    expect((await w.gateway.commitEffect({}, committer())).refused).toBe("'draft_ref' must be a draft://<id> reference");
  });

  it('refuses an unknown draft', async () => {
    const w = makeWorld();
    const result = await w.gateway.commitEffect({ draft_ref: 'draft://missing' }, committer());
    expect(result.refused).toBe("unknown draft 'draft://missing'");
  });

  it('refuses committing a discarded draft', async () => {
    const w = makeWorld();
    const ref = await draftAs(w, committer(), crmDraftParams());
    await w.gateway.discardEffect({ draft_ref: ref, reason: 'withdrawn' }, committer());
    const result = await w.gateway.commitEffect({ draft_ref: ref }, committer());
    expect(result.refused).toContain('already discarded');
  });

  it('refuses an expired draft', async () => {
    const w = makeWorld();
    const ref = await draftAs(w, committer(), crmDraftParams({ expiry: w.clock.value + 1000 }));
    w.clock.value += 2000;
    const result = await w.gateway.commitEffect({ draft_ref: ref }, committer());
    expect(result.refused).toBe('draft expired — refusing to commit');
    expect(noExecutions(w)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// commit_effect — approval class (human actor)
// ---------------------------------------------------------------------------

function approvedApproval(
  approvalStore: World['approvalStore'],
  ref: string,
  tool: string,
  approverId: string,
  overrides: Partial<PendingApproval> = {}
): string {
  const id = `appr_${Math.floor(Math.random() * 1e6)}`;
  const approval: PendingApproval = {
    id,
    sessionId: RUN_ID,
    teamId: RUN_ID,
    correlationId: CORR,
    serverAlias: SERVER_ALIAS,
    toolName: tool,
    paramsJson: JSON.stringify({ draft_ref: ref }),
    requestedAt: 1_000_000,
    timeoutAt: 2_000_000,
    requestHash: 'hash',
    decision: 'approved',
    approverId,
    ...overrides,
  };
  approvalStore.createApproval(approval);
  return id;
}

describe('commit_effect approval class', () => {
  it('an irreversible effect refuses an agent actor (anonymous approve)', async () => {
    const w = makeWorld();
    const ref = await draftAs(w, committer(), emailDraftParams());
    const approvalId = approvedApproval(w.approvalStore, ref, COMMIT_EFFECT, '');
    const result = await w.gateway.commitEffect({ draft_ref: ref }, { ...committer(), approvalId });
    expect(result.committed).toBe(false);
    expect(result.refused).toContain('irreversible');
    expect(result.refused).toContain('unnamed human');
    expect(w.connectors.get('email')!.executions).toHaveLength(0);
  });

  it('an irreversible effect commits for a named human approver', async () => {
    const w = makeWorld();
    const ref = await draftAs(w, committer(), emailDraftParams());
    const approvalId = approvedApproval(w.approvalStore, ref, COMMIT_EFFECT, 'entra://d.moreau@contoso.example');
    const result = await w.gateway.commitEffect({ draft_ref: ref }, { ...committer(), approvalId });
    expect(result.committed).toBe(true);
    expect(result.decision?.actor).toEqual({ kind: 'human', approver_id: 'entra://d.moreau@contoso.example' });
    expect(w.connectors.get('email')!.executions).toEqual([
      { effectType: 'comms.email.send', payload: { to: 'c@example.com', template: 'refund_v2' }, credentialKeys: ['email_api_key'] },
    ]);
  });

  it('an approval for a different draft cannot authorise', async () => {
    const w = makeWorld();
    const ref = await draftAs(w, committer(), emailDraftParams());
    const otherRef = await draftAs(w, committer(), emailDraftParams({ idempotency_key: 'fx_run_1_email_other' }));
    const approvalId = approvedApproval(w.approvalStore, otherRef, COMMIT_EFFECT, 'entra://approver');
    const result = await w.gateway.commitEffect({ draft_ref: ref }, { ...committer(), approvalId });
    expect(result.committed).toBe(false);
    expect(result.refused).toContain('authorises draft');
    expect(noExecutions(w)).toBe(true);
  });

  it('refuses when the approval authorises a different tool', async () => {
    const w = makeWorld();
    const ref = await draftAs(w, committer(), emailDraftParams());
    const approvalId = approvedApproval(w.approvalStore, ref, DISCARD_EFFECT, 'entra://approver');
    const result = await w.gateway.commitEffect({ draft_ref: ref }, { ...committer(), approvalId });
    expect(result.refused).toContain(`not ${SERVER_ALIAS}.${COMMIT_EFFECT}`);
  });

  it('refuses when the referenced approval is missing', async () => {
    const w = makeWorld();
    const ref = await draftAs(w, committer(), emailDraftParams());
    const result = await w.gateway.commitEffect({ draft_ref: ref }, { ...committer(), approvalId: 'appr_missing' });
    expect(result.refused).toContain("approval 'appr_missing' not found");
  });

  it('refuses when the approval is not yet approved', async () => {
    const w = makeWorld();
    const ref = await draftAs(w, committer(), emailDraftParams());
    const approvalId = approvedApproval(w.approvalStore, ref, COMMIT_EFFECT, 'entra://approver', { decision: undefined });
    const result = await w.gateway.commitEffect({ draft_ref: ref }, { ...committer(), approvalId });
    expect(result.refused).toContain("is 'pending', not approved");
  });

  it('tolerates an approval whose params carry no draft binding', async () => {
    const w = makeWorld();
    const ref = await draftAs(w, committer(), emailDraftParams());
    const approvalId = approvedApproval(w.approvalStore, ref, COMMIT_EFFECT, 'entra://approver', { paramsJson: '{}' });
    const result = await w.gateway.commitEffect({ draft_ref: ref }, { ...committer(), approvalId });
    expect(result.committed).toBe(true);
  });

  it('tolerates an approval with unparseable params', async () => {
    const w = makeWorld();
    const ref = await draftAs(w, committer(), emailDraftParams());
    const approvalId = approvedApproval(w.approvalStore, ref, COMMIT_EFFECT, 'entra://approver', { paramsJson: 'not json' });
    const result = await w.gateway.commitEffect({ draft_ref: ref }, { ...committer(), approvalId });
    expect(result.committed).toBe(true);
  });

  it('refuses a human-required commit when no approval store is configured', async () => {
    const clock = { value: 1_000_000 };
    const gateway = new EffectGateway({
      effectTypes: effectTypes(),
      signingSecret: SECRET,
      connectors: new Map([['email', new RecordingConnector('email')]]),
      evidenceResolver: new MapVerificationResolver({ 'verify://ok': { ref: 'verify://ok', verifier: 'p', passed: true } }),
      now: () => clock.value,
    });
    // draft directly (no approval store)
    const drafted = await gateway.draftEffect(emailDraftParams(), committer());
    const result = await gateway.commitEffect({ draft_ref: drafted.draftRef! }, { ...committer(), approvalId: 'x' });
    expect(result.refused).toContain('no approval store is configured');
  });
});

// ---------------------------------------------------------------------------
// commit_effect — async approval flow (resume by resubmit + notification)
// ---------------------------------------------------------------------------

describe('commit_effect async approval flow', () => {
  it('creates a pending approval and notifies, then commits on resubmit after approval', async () => {
    const w = makeWorld();
    const ref = await draftAs(w, committer(), emailDraftParams());

    const first = await w.gateway.commitEffect({ draft_ref: ref }, committer());
    expect(first.approvalPending).toBe(true);
    expect(first.approvalId).toBeDefined();
    expect(w.notified).toHaveLength(1);
    expect(w.notified[0].evidence.requires_human_actor).toBe(true);
    expect(w.notified[0].evidence.evidence[0].result?.passed).toBe(true);
    expect(w.connectors.get('email')!.executions).toHaveLength(0);

    // Still pending on a second submit before resolution.
    const pending = await w.gateway.commitEffect({ draft_ref: ref }, committer());
    expect(pending.approvalPending).toBe(true);

    w.approvalStore.resolveApproval(first.approvalId!, 'approved', { kind: 'slack', id: 'slack://U04' });
    const committed = await w.gateway.commitEffect({ draft_ref: ref }, committer());
    expect(committed.committed).toBe(true);
    expect(committed.decision?.actor).toEqual({ kind: 'human', approver_id: 'slack://U04' });
    expect(w.connectors.get('email')!.executions).toHaveLength(1);
  });

  it('refuses when the operator denied the approval', async () => {
    const w = makeWorld();
    const ref = await draftAs(w, committer(), emailDraftParams());
    const first = await w.gateway.commitEffect({ draft_ref: ref }, committer());
    w.approvalStore.resolveApproval(first.approvalId!, 'denied', { kind: 'dashboard', id: 'op' });
    const result = await w.gateway.commitEffect({ draft_ref: ref }, committer());
    expect(result.refused).toContain('denied by the operator');
  });

  it('reports a timed-out pending approval', async () => {
    const w = makeWorld();
    const ref = await draftAs(w, committer(), emailDraftParams());
    await w.gateway.commitEffect({ draft_ref: ref }, committer());
    w.clock.value += 16 * 60_000;
    const result = await w.gateway.commitEffect({ draft_ref: ref }, committer());
    expect(result.refused).toContain('timed out');
  });

  it('reports a timed-out already-approved approval', async () => {
    const w = makeWorld();
    const ref = await draftAs(w, committer(), emailDraftParams());
    const first = await w.gateway.commitEffect({ draft_ref: ref }, committer());
    w.approvalStore.resolveApproval(first.approvalId!, 'approved', { kind: 'slack', id: 'slack://U04' });
    w.clock.value += 16 * 60_000;
    const result = await w.gateway.commitEffect({ draft_ref: ref }, committer());
    expect(result.refused).toContain('timed out');
    expect(w.connectors.get('email')!.executions).toHaveLength(0);
  });

  it('an approved-but-anonymous resubmit is refused', async () => {
    const w = makeWorld();
    const ref = await draftAs(w, committer(), emailDraftParams());
    const first = await w.gateway.commitEffect({ draft_ref: ref }, committer());
    w.approvalStore.resolveApproval(first.approvalId!, 'approved');
    const result = await w.gateway.commitEffect({ draft_ref: ref }, committer());
    expect(result.refused).toContain('unnamed human');
  });

  it('routes a sampled effect to human review when the sampler selects it', async () => {
    const w = makeWorld({ sampler: () => true });
    const ref = await draftAs(w, committer(), {
      effect_type: 'payment.refund',
      target_system: 'payments',
      payload: { order_id: 'ord_8812', amount_usd: 94 },
      evidence: ['verify://ok'],
      reversibility: 'compensatable',
      idempotency_key: 'fx_refund',
    });
    const first = await w.gateway.commitEffect({ draft_ref: ref }, committer());
    expect(first.approvalPending).toBe(true);
    w.approvalStore.resolveApproval(first.approvalId!, 'approved', { kind: 'dashboard', id: 'qa-reviewer' });
    const committed = await w.gateway.commitEffect({ draft_ref: ref }, committer());
    expect(committed.committed).toBe(true);
    expect(committed.decision?.actor).toEqual({ kind: 'human', approver_id: 'qa-reviewer' });
  });

  it('routes a sampled effect that fails human resolution to a sampled-review refusal', async () => {
    const w = makeWorld({ sampler: () => true });
    const ref = await draftAs(w, committer(), {
      effect_type: 'payment.refund',
      target_system: 'payments',
      payload: { order_id: 'ord_8812', amount_usd: 94 },
      evidence: ['verify://ok'],
      reversibility: 'compensatable',
      idempotency_key: 'fx_refund_anon',
    });
    const approvalId = approvedApproval(w.approvalStore, ref, COMMIT_EFFECT, '');
    const result = await w.gateway.commitEffect({ draft_ref: ref }, { ...committer(), approvalId });
    expect(result.committed).toBe(false);
    expect(result.refused).toContain('sampled for human review');
    expect(w.connectors.get('payments')!.executions).toHaveLength(0);
  });

  it('auto-commits a sampled effect not selected by the default sampler', async () => {
    const w = makeWorld();
    const ref = await draftAs(w, committer(), {
      effect_type: 'payment.refund',
      target_system: 'payments',
      payload: { order_id: 'ord_8812', amount_usd: 94 },
      evidence: ['verify://ok'],
      reversibility: 'compensatable',
      idempotency_key: 'fx_refund_auto',
    });
    const result = await w.gateway.commitEffect({ draft_ref: ref }, committer());
    expect(result.committed).toBe(true);
    expect(result.decision?.actor.kind).toBe('agent');
    expect(w.connectors.get('payments')!.executions).toHaveLength(1);
  });

  it('swallows a failing approval notifier without losing the approval', async () => {
    const w = makeWorld({ approvalNotifier: async () => { throw new Error('slack down'); } });
    const ref = await draftAs(w, committer(), emailDraftParams());
    const result = await w.gateway.commitEffect({ draft_ref: ref }, committer());
    expect(result.approvalPending).toBe(true);
    expect(result.approvalId).toBeDefined();
  });

  it('swallows a notifier that throws a non-Error value', async () => {
    const w = makeWorld({
      approvalNotifier: async () => {
        throw 'plain string failure';
      },
    });
    const ref = await draftAs(w, committer(), emailDraftParams());
    const result = await w.gateway.commitEffect({ draft_ref: ref }, committer());
    expect(result.approvalPending).toBe(true);
  });

  it('does not throw when no notifier is configured', async () => {
    const clock = { value: 1_000_000 };
    const approvalStore = createMemoryStore(() => clock.value);
    const gateway = new EffectGateway({
      effectTypes: effectTypes(),
      approvalStore,
      signingSecret: SECRET,
      evidenceResolver: new MapVerificationResolver({ 'verify://ok': { ref: 'verify://ok', verifier: 'p', passed: true } }),
      connectors: new Map([['email', new RecordingConnector('email')]]),
      now: () => clock.value,
    });
    const drafted = await gateway.draftEffect(emailDraftParams(), committer());
    const result = await gateway.commitEffect({ draft_ref: drafted.draftRef! }, committer());
    expect(result.approvalPending).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// commit_effect — idempotency & fail-closed
// ---------------------------------------------------------------------------

describe('commit_effect idempotency and connectors', () => {
  it('committing the same draft twice executes once', async () => {
    const w = makeWorld();
    const ref = await draftAs(w, committer(), crmDraftParams());
    const first = await w.gateway.commitEffect({ draft_ref: ref }, committer());
    const second = await w.gateway.commitEffect({ draft_ref: ref }, committer());
    expect(first.committed).toBe(true);
    expect(second.committed).toBe(true);
    expect(second.idempotentReplay).toBe(true);
    expect(second.outcome).toEqual(first.outcome);
    expect(w.connectors.get('crm')!.executions).toHaveLength(1);
  });

  it('a sibling draft sharing an idempotency key replays the recorded outcome', async () => {
    const w = makeWorld();
    const first = await draftAs(w, committer(), crmDraftParams());
    await w.gateway.commitEffect({ draft_ref: first }, committer());
    const sibling = await draftAs(w, committer(), crmDraftParams());
    const result = await w.gateway.commitEffect({ draft_ref: sibling }, committer());
    expect(result.idempotentReplay).toBe(true);
    expect(w.connectors.get('crm')!.executions).toHaveLength(1);
  });

  it('fails closed when no connector is mounted for the target system', async () => {
    const w = makeWorld();
    const ref = await draftAs(w, committer(), {
      effect_type: 'crm.case_note.append',
      target_system: 'erp',
      payload: {},
      evidence: ['verify://ok'],
      reversibility: 'reversible',
      idempotency_key: 'fx_erp',
    });
    const result = await w.gateway.commitEffect({ draft_ref: ref }, committer());
    expect(result.refused).toContain('no connector mounted');
    expect(noExecutions(w)).toBe(true);
  });
});

describe('commit_effect edge paths', () => {
  it('refuses a non-object params payload', async () => {
    const w = makeWorld();
    expect((await w.gateway.commitEffect('nope', committer())).refused).toBe(
      "'draft_ref' must be a draft://<id> reference"
    );
  });

  it('refuses a human-required commit with no approval store and no approval id', async () => {
    const clock = { value: 1_000_000 };
    const gateway = new EffectGateway({
      effectTypes: effectTypes(),
      signingSecret: SECRET,
      connectors: new Map([['email', new RecordingConnector('email')]]),
      evidenceResolver: new MapVerificationResolver({ 'verify://ok': { ref: 'verify://ok', verifier: 'p', passed: true } }),
      now: () => clock.value,
    });
    const drafted = await gateway.draftEffect(emailDraftParams(), committer());
    const result = await gateway.commitEffect({ draft_ref: drafted.draftRef! }, committer());
    expect(result.refused).toContain('no approval store is configured');
  });

  it('propagates a connector failure and keeps the decision chain usable', async () => {
    const clock = { value: 1_000_000 };
    const throwing = {
      targetSystem: 'crm',
      execute: async () => {
        throw new Error('connector down');
      },
    };
    const gateway = new EffectGateway({
      effectTypes: effectTypes(),
      signingSecret: SECRET,
      connectors: new Map([['crm', throwing]]),
      evidenceResolver: new MapVerificationResolver({ 'verify://ok': { ref: 'verify://ok', verifier: 'p', passed: true } }),
      now: () => clock.value,
    });
    const drafted = await gateway.draftEffect(crmDraftParams(), committer());
    await expect(gateway.commitEffect({ draft_ref: drafted.draftRef! }, committer())).rejects.toThrow('connector down');
    // the gateway still serialises and serves subsequent calls
    const again = await gateway.commitEffect({ draft_ref: 'draft://missing' }, committer());
    expect(again.refused).toBe("unknown draft 'draft://missing'");
  });

  it('handles a lost commit race that resolves to committed, then to discarded', async () => {
    const base = sampleRecord({ id: 'draft_race' });
    const committedRow = {
      ...base,
      status: 'committed' as const,
      decisionActor: { kind: 'human' as const, approver_id: 'h' },
      outcome: { executed: true },
      decidedAt: 2,
    };
    const discardedRow = {
      ...base,
      status: 'discarded' as const,
      decisionActor: { kind: 'human' as const, approver_id: 'h' },
      decisionReason: 'x',
      decidedAt: 2,
    };
    const raceStore = (finalStatus: 'committed' | 'discarded') => {
      let calls = 0;
      return {
        saveDraft() {},
        findByIdempotencyKey: () => undefined,
        listDrafts: () => [],
        getDraft: () => {
          calls += 1;
          return calls === 1 ? base : finalStatus === 'committed' ? committedRow : discardedRow;
        },
        recordDecision: () => false,
      };
    };
    const clock = { value: 1_000_000 };
    const mkGateway = (finalStatus: 'committed' | 'discarded') =>
      new EffectGateway({
        store: raceStore(finalStatus),
        effectTypes: effectTypes(),
        signingSecret: SECRET,
        connectors: new Map([['crm', new RecordingConnector('crm')]]),
        evidenceResolver: new MapVerificationResolver({ 'verify://ok': { ref: 'verify://ok', verifier: 'p', passed: true } }),
        now: () => clock.value,
      });
    const wonByOther = await mkGateway('committed').commitEffect({ draft_ref: 'draft://draft_race' }, committer());
    expect(wonByOther.committed).toBe(true);
    expect(wonByOther.idempotentReplay).toBe(true);
    const lostToDiscard = await mkGateway('discarded').commitEffect({ draft_ref: 'draft://draft_race' }, committer());
    expect(lostToDiscard.refused).toContain('already discarded');
  });

  it('handles a lost discard race that resolves to discarded, then to committed', async () => {
    const base = sampleRecord({ id: 'draft_drace' });
    const discardedRow = {
      ...base,
      status: 'discarded' as const,
      decisionActor: { kind: 'human' as const, approver_id: 'h' },
      decisionReason: 'x',
      decidedAt: 2,
    };
    const committedRow = {
      ...base,
      status: 'committed' as const,
      decisionActor: { kind: 'human' as const, approver_id: 'h' },
      outcome: { executed: true },
      decidedAt: 2,
    };
    const raceStore = (finalStatus: 'discarded' | 'committed') => {
      let calls = 0;
      return {
        saveDraft() {},
        findByIdempotencyKey: () => undefined,
        listDrafts: () => [],
        getDraft: () => {
          calls += 1;
          return calls === 1 ? base : finalStatus === 'discarded' ? discardedRow : committedRow;
        },
        recordDecision: () => false,
      };
    };
    const clock = { value: 1_000_000 };
    const mkGateway = (finalStatus: 'discarded' | 'committed') =>
      new EffectGateway({
        store: raceStore(finalStatus),
        effectTypes: effectTypes(),
        signingSecret: SECRET,
        now: () => clock.value,
      });
    const wonByOther = await mkGateway('discarded').discardEffect(
      { draft_ref: 'draft://draft_drace', reason: 'withdraw' },
      committer()
    );
    expect(wonByOther.discarded).toBe(true);
    expect(wonByOther.idempotentReplay).toBe(true);
    const lostToCommit = await mkGateway('committed').discardEffect(
      { draft_ref: 'draft://draft_drace', reason: 'withdraw' },
      committer()
    );
    expect(lostToCommit.refused).toContain('already committed');
  });
});

// ---------------------------------------------------------------------------
// discard_effect
// ---------------------------------------------------------------------------

describe('discard_effect', () => {
  it('discards a draft with a reason and executes nothing', async () => {
    const w = makeWorld();
    const ref = await draftAs(w, committer(), crmDraftParams());
    const result = await w.gateway.discardEffect({ draft_ref: ref, reason: 'withdrawn after review' }, committer());
    expect(result.discarded).toBe(true);
    expect(result.decision?.decision).toBe('discard');
    expect(result.decision?.reason).toBe('withdrawn after review');
    expect(noExecutions(w)).toBe(true);
    expect(w.audits).toContainEqual({ kind: 'effect_discard', status: 'discarded', effectType: 'crm.case_note.append' });
  });

  it('requires a non-empty reason', async () => {
    const w = makeWorld();
    const ref = await draftAs(w, committer(), crmDraftParams());
    expect((await w.gateway.discardEffect({ draft_ref: ref, reason: '   ' }, committer())).refused).toContain('non-empty');
    expect((await w.gateway.discardEffect({ draft_ref: ref }, committer())).refused).toContain('non-empty');
  });

  it('is idempotent on a second discard', async () => {
    const w = makeWorld();
    const ref = await draftAs(w, committer(), crmDraftParams());
    await w.gateway.discardEffect({ draft_ref: ref, reason: 'withdrawn' }, committer());
    const again = await w.gateway.discardEffect({ draft_ref: ref, reason: 'again' }, committer());
    expect(again.discarded).toBe(true);
    expect(again.idempotentReplay).toBe(true);
  });

  it('cannot discard a committed draft', async () => {
    const w = makeWorld();
    const ref = await draftAs(w, committer(), crmDraftParams());
    await w.gateway.commitEffect({ draft_ref: ref }, committer());
    const result = await w.gateway.discardEffect({ draft_ref: ref, reason: 'too late' }, committer());
    expect(result.refused).toContain('already committed');
  });

  it('refuses an unknown draft', async () => {
    const w = makeWorld();
    const result = await w.gateway.discardEffect({ draft_ref: 'draft://missing', reason: 'x' }, committer());
    expect(result.refused).toBe("unknown draft 'draft://missing'");
  });

  it('requires a named human to discard an irreversible draft', async () => {
    const w = makeWorld();
    const ref = await draftAs(w, committer(), emailDraftParams());
    const noHuman = await w.gateway.discardEffect({ draft_ref: ref, reason: 'withdraw' }, committer());
    expect(noHuman.refused).toContain('requires a human decision on discard too');
    expect(noHuman.refused).toContain('did not arrive through a resolved approval');
  });

  it('discards an irreversible draft when a named human approved the discard', async () => {
    const w = makeWorld();
    const ref = await draftAs(w, committer(), emailDraftParams());
    const approvalId = approvedApproval(w.approvalStore, ref, DISCARD_EFFECT, 'entra://approver');
    const result = await w.gateway.discardEffect({ draft_ref: ref, reason: 'withdraw' }, { ...committer(), approvalId });
    expect(result.discarded).toBe(true);
    expect(result.decision?.actor).toEqual({ kind: 'human', approver_id: 'entra://approver' });
  });

  it('refuses an irreversible discard when the approval store is absent', async () => {
    const clock = { value: 1_000_000 };
    const gateway = new EffectGateway({ effectTypes: effectTypes(), signingSecret: SECRET, now: () => clock.value });
    const drafted = await gateway.draftEffect(emailDraftParams(), committer());
    const result = await gateway.discardEffect(
      { draft_ref: drafted.draftRef!, reason: 'x' },
      { ...committer(), approvalId: 'a' }
    );
    expect(result.refused).toContain('no approval store is configured');
  });
});

// ---------------------------------------------------------------------------
// The decisive multi-path test
// ---------------------------------------------------------------------------

describe('an agent that can draft but not commit causes no external write', () => {
  it('every path leaves every connector idle and no draft reaches committed', async () => {
    const w = makeWorld();
    const drafter = { agentId: 'drafter', identityToken: mintToken('drafter'), scopeId: RUN_ID, correlationId: CORR };

    // (a) commit with no identity token
    const ref = await draftAs(w, drafter, emailDraftParams());
    expect((await w.gateway.commitEffect({ draft_ref: ref }, { agentId: 'committer' })).committed).toBe(false);
    // (b) commit with a foreign token
    expect(
      (await w.gateway.commitEffect({ draft_ref: ref }, { agentId: 'committer', identityToken: mintToken('impostor'), scopeId: RUN_ID })).committed
    ).toBe(false);
    // (c) irreversible commit with an anonymous approval
    const anon = approvedApproval(w.approvalStore, ref, COMMIT_EFFECT, '');
    expect((await w.gateway.commitEffect({ draft_ref: ref }, { ...committer(), approvalId: anon })).committed).toBe(false);
    // (d) smuggled fields at draft time
    expect((await w.gateway.draftEffect(emailDraftParams({ actor: { kind: 'human' } }), drafter)).drafted).toBe(false);
    // (e) context-less adapter commit
    const adapter = w.gateway.adapter();
    expect(((await adapter.callTool(COMMIT_EFFECT, { draft_ref: ref })) as { committed: boolean }).committed).toBe(false);
    // (f) drafter can still draft and discard (with a human for the irreversible draft)
    const discardApproval = approvedApproval(w.approvalStore, ref, DISCARD_EFFECT, 'entra://approver');
    const discarded = await w.gateway.discardEffect({ draft_ref: ref, reason: 'withdraw' }, { ...committer(), approvalId: discardApproval });
    expect(discarded.discarded).toBe(true);

    expect(noExecutions(w)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// credentials
// ---------------------------------------------------------------------------

describe('credential isolation', () => {
  it('hands credentials to the connector only at execute time', async () => {
    const w = makeWorld();
    const ref = await draftAs(w, committer(), crmDraftParams());
    await w.gateway.commitEffect({ draft_ref: ref }, committer());
    expect(w.connectors.get('crm')!.executions[0].credentialKeys).toEqual(['crm_api_key']);
  });

  it('never leaks secret values into any produced document', async () => {
    const w = makeWorld();
    const ref = await draftAs(w, committer(), crmDraftParams());
    const result = await w.gateway.commitEffect({ draft_ref: ref }, committer());
    const blob = JSON.stringify(result) + JSON.stringify(w.audits) + JSON.stringify(w.notified);
    expect(blob).not.toContain('CRM_KEY');
    expect(blob).not.toContain('EMAIL_KEY');
  });

  it('picks credentials up from the environment and masks them in JSON', () => {
    const creds = new EffectCredentials({ crm: 'explicit' });
    expect(creds.forSystem('crm')).toEqual({ crm_api_key: 'explicit' });
    expect(creds.forSystem('unknown')).toEqual({});
    process.env.TOOLSHED_EFFECT_ERP_API_KEY = 'from-env';
    try {
      expect(creds.forSystem('erp')).toEqual({ erp_api_key: 'from-env' });
    } finally {
      delete process.env.TOOLSHED_EFFECT_ERP_API_KEY;
    }
    expect(creds.systems()).toEqual(['crm']);
    expect(JSON.stringify(creds)).toBe(JSON.stringify({ crm: '***' }));
    expect(new EffectCredentials({ crm: '', keep: 'v' }).systems()).toEqual(['keep']);
    expect(new EffectCredentials().systems()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// governance & vocabulary
// ---------------------------------------------------------------------------

describe('governance and policy', () => {
  it('pins commit_effect as destructive, idempotently, and leaves discard alone', () => {
    const governance = { destructiveActions: [] } as unknown as GovernanceConfig;
    ensureEffectGatewayRules(governance);
    ensureEffectGatewayRules(governance);
    expect(governance.destructiveActions).toEqual([{ serverAlias: SERVER_ALIAS, toolName: COMMIT_EFFECT }]);
    expect(governance.destructiveActions.some((a) => a.toolName === DISCARD_EFFECT)).toBe(false);
  });

  it('the class vocabulary matches the contract', () => {
    expect([...APPROVAL_CLASSES]).toEqual(['auto', 'sampled', 'always_human']);
  });

  it('requiresHumanActor is the irreversible-or-always_human truth table', () => {
    expect(requiresHumanActor({ reversibility: 'irreversible', approvalClass: 'auto' })).toBe(true);
    expect(requiresHumanActor({ reversibility: 'reversible', approvalClass: 'always_human' })).toBe(true);
    expect(requiresHumanActor({ reversibility: 'reversible', approvalClass: 'auto' })).toBe(false);
    expect(requiresHumanActor({ reversibility: 'compensatable', approvalClass: 'sampled' })).toBe(false);
  });

  it('rejects an unknown reversibility or approval class', () => {
    expect(() => makeEffectTypePolicy('t', 'undoable', 'auto')).toThrow('reversibility must be one of');
    expect(() => makeEffectTypePolicy('t', 'reversible', 'maybe')).toThrow('approval_class must be one of');
  });

  it('parses and validates an effect_types mapping', () => {
    expect(() => effectTypesFromRecord('x')).toThrow('effect_types must be a mapping');
    expect(() => effectTypesFromRecord([])).toThrow('effect_types must be a mapping');
    expect(() => effectTypesFromRecord({ 'a.b': 'x' })).toThrow('effect_types.a.b must be a mapping');
    expect(() => effectTypesFromRecord({ 'a.b': { reversibility: 'reversible', approval_class: 'auto', extra: 1 } })).toThrow(
      'unknown keys extra'
    );
    expect(() => effectTypesFromRecord({ 'a.b': { reversibility: 'reversible' } })).toThrow('missing approval_class');
    const parsed = effectTypesFromRecord({ 'a.b': { reversibility: 'reversible', approval_class: 'auto' } });
    expect(parsed.get('a.b')).toEqual({ effectType: 'a.b', reversibility: 'reversible', approvalClass: 'auto' });
  });
});

describe('construction defaults', () => {
  it('a minimally-configured gateway drafts with all defaults applied', async () => {
    const gateway = new EffectGateway({ effectTypes: effectTypes() });
    const result = await gateway.draftEffect(crmDraftParams());
    expect(result.drafted).toBe(true);
    // No signing secret configured → a commit fails closed on identity.
    const commit = await gateway.commitEffect({ draft_ref: result.draftRef! });
    expect(commit.refused).toContain('identity verification is not configured');
  });

  it('MapVerificationResolver defaults to an empty view set', () => {
    const resolver = new MapVerificationResolver();
    expect(resolver.resolve('verify://anything')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// adapter surface
// ---------------------------------------------------------------------------

describe('MCP adapter surface', () => {
  it('lists three tools, is healthy, and routes dispatch', async () => {
    const w = makeWorld();
    const adapter = w.gateway.adapter();
    expect(adapter.alias).toBe(SERVER_ALIAS);
    expect(await adapter.health()).toEqual({ healthy: true, latencyMs: 0 });
    const tools = await adapter.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([COMMIT_EFFECT, DISCARD_EFFECT, DRAFT_EFFECT].sort());
    const unknown = (await adapter.callTool('nope', {})) as { error: string };
    expect(unknown.error).toBe("unknown tool 'nope'");
  });

  it('drafts through callTool and commits through callToolAs', async () => {
    const w = makeWorld();
    const adapter = w.gateway.adapter();
    const drafted = (await adapter.callTool(DRAFT_EFFECT, crmDraftParams())) as { drafted: boolean; draftRef: string };
    expect(drafted.drafted).toBe(true);
    const committed = (await adapter.callToolAs(COMMIT_EFFECT, { draft_ref: drafted.draftRef }, committer())) as {
      committed: boolean;
    };
    expect(committed.committed).toBe(true);
    const discarded = (await adapter.callToolAs(DISCARD_EFFECT, { draft_ref: 'draft://missing', reason: 'x' }, committer())) as {
      discarded: boolean;
    };
    expect(discarded.discarded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// effect-store internals
// ---------------------------------------------------------------------------

function sampleRecord(overrides: Partial<EffectDraftRecord> = {}): EffectDraftRecord {
  return {
    id: newDraftId(),
    sessionId: RUN_ID,
    correlationId: CORR,
    drafterAgentId: 'committer',
    drafterVerified: true,
    effectType: 'crm.case_note.append',
    targetSystem: 'crm',
    payload: { k: 1 },
    evidence: ['verify://ok'],
    reversibility: 'reversible',
    approvalClass: 'auto',
    idempotencyKey: 'k1',
    expiry: 2_000_000,
    status: 'draft',
    createdAt: 1_000_000,
    ...overrides,
  };
}

describe('effect-store reference and serialisation helpers', () => {
  it('parses draft refs both with and without the prefix', () => {
    expect(parseDraftRef('draft://abc')).toBe('abc');
    expect(parseDraftRef('abc')).toBe('abc');
    expect(draftRef('abc')).toBe('draft://abc');
    expect(newDraftId().startsWith('draft_')).toBe(true);
  });

  it('refuses to serialise an undecided or actorless record as a decision', () => {
    expect(() => toDecisionRecord(sampleRecord())).toThrow('is not decided');
    expect(() => toDecisionRecord(sampleRecord({ status: 'committed' }))).toThrow('has no decision actor');
  });

  it('serialises an audit view for both undecided and decided records', () => {
    const draft = toAuditView(sampleRecord());
    expect(draft).toMatchObject({ status: 'draft', drafter_verified: true });
    expect(draft.decided_at).toBeUndefined();
    const decided = toAuditView(
      sampleRecord({
        status: 'committed',
        decidedAt: 1_500_000,
        decisionActor: { kind: 'human', approver_id: 'h' },
        outcome: { executed: true },
      })
    );
    expect(decided.decided_at).toBe(1_500_000);
    expect(decided.actor).toEqual({ kind: 'human', approver_id: 'h' });
    expect(decided.outcome).toEqual({ executed: true });
  });
});

describe('memory effect store', () => {
  it('saves, reads, decides, and lists drafts', () => {
    const store = createMemoryEffectStore();
    const rec = sampleRecord();
    store.saveDraft(rec);
    expect(store.getDraft(rec.id)?.status).toBe('draft');
    expect(store.getDraft('missing')).toBeUndefined();

    expect(store.recordDecision('missing', { status: 'committed', actor: { kind: 'human', approver_id: 'h' }, decidedAt: 1 })).toBe(false);
    expect(store.recordDecision(rec.id, { status: 'committed', actor: { kind: 'human', approver_id: 'h' }, decidedAt: 1, outcome: { ok: true } })).toBe(true);
    expect(store.recordDecision(rec.id, { status: 'discarded', actor: { kind: 'human', approver_id: 'h' }, decidedAt: 2 })).toBe(false);
    expect(store.getDraft(rec.id)?.status).toBe('committed');

    store.saveDraft(sampleRecord({ id: 'draft_earlier', createdAt: 500_000 }));
    const listed = store.listDrafts();
    expect(listed.map((r) => r.id)).toEqual(['draft_earlier', rec.id]); // sorted by createdAt
    expect(store.listDrafts({ sessionId: RUN_ID, status: 'committed' }).map((r) => r.id)).toEqual([rec.id]);
    expect(store.listDrafts({ sessionId: 'other' }).length).toBe(0);
    expect(store.listDrafts({ status: 'draft' }).map((r) => r.id)).toEqual(['draft_earlier']);
  });

  it('finds by idempotency key with committed rows first', () => {
    const store = createMemoryEffectStore();
    const a = sampleRecord({ id: 'draft_a', idempotencyKey: 'shared', createdAt: 10 });
    const b = sampleRecord({ id: 'draft_b', idempotencyKey: 'shared', createdAt: 20 });
    store.saveDraft(a);
    store.saveDraft(b);
    expect(store.findByIdempotencyKey('shared')?.id).toBe('draft_a'); // both draft → earliest created
    store.recordDecision('draft_b', { status: 'committed', actor: { kind: 'human', approver_id: 'h' }, decidedAt: 30 });
    expect(store.findByIdempotencyKey('shared')?.id).toBe('draft_b'); // committed first
    expect(store.findByIdempotencyKey('none')).toBeUndefined();
  });
});

type FakeStatement = {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
};

const INSERT_COLUMNS = [
  'id',
  'session_id',
  'correlation_id',
  'drafter_agent_id',
  'drafter_verified',
  'effect_type',
  'target_system',
  'payload_json',
  'evidence_json',
  'reversibility',
  'approval_class',
  'idempotency_key',
  'expiry',
  'status',
  'created_at',
  'decided_at',
  'decision_actor_json',
  'decision_reason',
  'outcome_json',
];

class FakeEffectDatabase {
  rows = new Map<string, Record<string, unknown>>();
  exec = jest.fn();
  close = jest.fn();

  prepare(sql: string): FakeStatement {
    const rows = this.rows;
    const empty: FakeStatement = { run: () => ({ changes: 0 }), get: () => undefined, all: () => [] };
    if (sql.startsWith('INSERT')) {
      return {
        ...empty,
        run: (...params: unknown[]) => {
          const row: Record<string, unknown> = {};
          INSERT_COLUMNS.forEach((col, i) => (row[col] = params[i]));
          rows.set(String(params[0]), row);
          return { changes: 1 };
        },
      };
    }
    if (sql.startsWith('UPDATE')) {
      return {
        ...empty,
        run: (...params: unknown[]) => {
          const id = String(params[5]);
          const row = rows.get(id);
          if (row && row.status === 'draft') {
            row.status = params[0];
            row.decided_at = params[1];
            row.decision_actor_json = params[2];
            row.decision_reason = params[3];
            row.outcome_json = params[4];
            return { changes: 1 };
          }
          return { changes: 0 };
        },
      };
    }
    if (sql.includes('idempotency_key = ?')) {
      return {
        ...empty,
        get: (key: unknown) => {
          const matches = Array.from(rows.values())
            .filter((r) => r.idempotency_key === key)
            .sort((a, b) => {
              const rank = (r: Record<string, unknown>) => (r.status === 'committed' ? 0 : 1);
              return rank(a) - rank(b) || Number(a.created_at) - Number(b.created_at);
            });
          return matches[0];
        },
      };
    }
    if (sql.includes('WHERE id = ?')) {
      return { ...empty, get: (id: unknown) => rows.get(String(id)) };
    }
    if (sql.includes('WHERE session_id = ?')) {
      return { ...empty, all: (sid: unknown) => Array.from(rows.values()).filter((r) => r.session_id === sid) };
    }
    return { ...empty, all: () => Array.from(rows.values()) };
  }
}

describe('sqlite effect store', () => {
  it('exercises the SQL logic against a mock database', () => {
    const store = createSqliteEffectStore(':memory:', FakeEffectDatabase as unknown as new (path: string) => FakeEffectDatabase);

    const rec = sampleRecord({ id: 'draft_sql', decisionReason: undefined });
    store.saveDraft(rec);
    const read = store.getDraft('draft_sql');
    expect(read?.status).toBe('draft');
    expect(read?.decidedAt).toBeUndefined();
    expect(read?.decisionActor).toBeUndefined();
    expect(read?.outcome).toBeUndefined();
    expect(store.getDraft('missing')).toBeUndefined();

    expect(store.findByIdempotencyKey('k1')?.id).toBe('draft_sql');
    expect(store.findByIdempotencyKey('none')).toBeUndefined();

    expect(store.listDrafts().length).toBe(1);
    expect(store.listDrafts({ sessionId: RUN_ID }).length).toBe(1);
    expect(store.listDrafts({ status: 'committed' }).length).toBe(0);

    expect(
      store.recordDecision('draft_sql', {
        status: 'committed',
        actor: { kind: 'agent', token_payload: { agent_id: 'committer', scope_id: RUN_ID, correlation_id: CORR, exp: 9 } },
        reason: 'because',
        outcome: { executed: true },
        decidedAt: 1_500_000,
      })
    ).toBe(true);
    const decided = store.getDraft('draft_sql');
    expect(decided?.status).toBe('committed');
    expect(decided?.decidedAt).toBe(1_500_000);
    expect(decided?.decisionActor).toEqual({ kind: 'agent', token_payload: expect.objectContaining({ agent_id: 'committer' }) });
    expect(decided?.outcome).toEqual({ executed: true });
    // compare-and-set: a second decision on the now-committed row writes nothing
    expect(
      store.recordDecision('draft_sql', { status: 'discarded', actor: { kind: 'human', approver_id: 'h' }, decidedAt: 2 })
    ).toBe(false);
  });

  it('falls back to a memory store when the constructor throws (dev)', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalAllow = process.env.TOOLSHED_ALLOW_MEMORY_STORE;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      delete process.env.NODE_ENV;
      delete process.env.TOOLSHED_ALLOW_MEMORY_STORE;
      const throwing = (() => {
        throw new Error('no native binding');
      }) as unknown as new (path: string) => FakeEffectDatabase;
      const store = createSqliteEffectStore(':memory:', throwing);
      store.saveDraft(sampleRecord({ id: 'mem' }));
      expect(store.getDraft('mem')?.id).toBe('mem');
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      restoreEnv('NODE_ENV', originalNodeEnv);
      restoreEnv('TOOLSHED_ALLOW_MEMORY_STORE', originalAllow);
    }
  });

  it('refuses to fall back in production without the escape hatch', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalAllow = process.env.TOOLSHED_ALLOW_MEMORY_STORE;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.TOOLSHED_ALLOW_MEMORY_STORE;
      const throwing = (() => {
        throw 'string failure';
      }) as unknown as new (path: string) => FakeEffectDatabase;
      expect(() => createSqliteEffectStore(':memory:', throwing)).toThrow('refusing to silently fall back');
    } finally {
      restoreEnv('NODE_ENV', originalNodeEnv);
      restoreEnv('TOOLSHED_ALLOW_MEMORY_STORE', originalAllow);
    }
  });

  it('falls back in production when the escape hatch is set', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalAllow = process.env.TOOLSHED_ALLOW_MEMORY_STORE;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      process.env.NODE_ENV = 'production';
      process.env.TOOLSHED_ALLOW_MEMORY_STORE = '1';
      const throwing = (() => {
        throw new Error('boom');
      }) as unknown as new (path: string) => FakeEffectDatabase;
      const store = createSqliteEffectStore(':memory:', throwing);
      expect(store.getDraft('missing')).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
      restoreEnv('NODE_ENV', originalNodeEnv);
      restoreEnv('TOOLSHED_ALLOW_MEMORY_STORE', originalAllow);
    }
  });

  it('loads the native module when no constructor is injected', () => {
    // In this environment the native binding cannot instantiate, so this
    // exercises loadBetterSqlite3 and the fallback; on a matching ABI it would
    // return a real SQLite-backed store. Either way it yields a working store.
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = createSqliteEffectStore(':memory:');
      store.saveDraft(sampleRecord({ id: 'native' }));
      expect(store.getDraft('native')?.id).toBe('native');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

// ---------------------------------------------------------------------------
// effects/v1 schema conformance (skips if the contracts checkout is absent)
// ---------------------------------------------------------------------------

const CONTRACTS_DIR = process.env.FORGE_CONTRACTS_DIR ?? '/Volumes/ExtDisk1/forge-contracts';
const effectsSchemaPath = join(CONTRACTS_DIR, 'schemas', 'effects', 'v1', 'schema.json');
const identitySchemaPath = join(CONTRACTS_DIR, 'schemas', 'identity', 'v1', 'schema.json');
const contractsPresent = existsSync(effectsSchemaPath) && existsSync(identitySchemaPath);

if (!contractsPresent) {
  console.warn(
    `[effect-gateway.test] FORGE_CONTRACTS_DIR schema tree not found at ${CONTRACTS_DIR}; skipping effects/v1 schema conformance.`
  );
}

const describeConformance = contractsPresent ? describe : describe.skip;

describeConformance('effects/v1 schema conformance', () => {
  // Ajv is loaded lazily so the module import cost is only paid when present.
  let validate: (doc: unknown) => boolean;

  beforeEach(async () => {
    const { Ajv2020 } = await import('ajv/dist/2020.js');
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    ajv.addSchema(JSON.parse(readFileSync(identitySchemaPath, 'utf8')));
    validate = ajv.compile(JSON.parse(readFileSync(effectsSchemaPath, 'utf8')));
  });

  function committedRecord(actor: { kind: 'agent' | 'human'; [k: string]: unknown }, status: 'committed' | 'discarded' = 'committed'): EffectDraftRecord {
    return sampleRecord({
      status,
      reversibility: actor.kind === 'human' ? 'irreversible' : 'compensatable',
      decidedAt: 1_500_000,
      decisionActor: actor as never,
      decisionReason: status === 'discarded' ? 'withdrawn' : undefined,
      outcome: { executed: true },
    });
  }

  it('the produced draft document validates', () => {
    const record = sampleRecord();
    const doc = toAuditView(record);
    // strip audit-only keys to obtain the pure effect_draft document
    const draftDoc = {
      effect_type: doc.effect_type,
      target_system: doc.target_system,
      payload: doc.payload,
      evidence: doc.evidence,
      reversibility: doc.reversibility,
      idempotency_key: doc.idempotency_key,
      expiry: doc.expiry,
    };
    expect(validate(draftDoc)).toBe(true);
  });

  it('an agent commit decision validates', () => {
    const record = committedRecord({
      kind: 'agent',
      token_payload: { agent_id: 'committer', scope_id: RUN_ID, correlation_id: CORR, exp: 4102444800000 },
    });
    expect(validate(toDecisionRecord(record))).toBe(true);
  });

  it('a human commit decision for an irreversible draft validates', () => {
    const record = committedRecord({ kind: 'human', approver_id: 'entra://approver' });
    expect(validate(toDecisionRecord(record))).toBe(true);
  });

  it('a discard decision validates', () => {
    const record = committedRecord({ kind: 'human', approver_id: 'entra://approver' }, 'discarded');
    expect(validate(toDecisionRecord(record))).toBe(true);
  });

  it('an irreversible decision paired with an agent actor is rejected', () => {
    const record = committedRecord({
      kind: 'agent',
      token_payload: { agent_id: 'drafter', scope_id: RUN_ID, correlation_id: CORR, exp: 4102444800000 },
    });
    // force the embedded draft to irreversible while keeping the agent actor
    record.reversibility = 'irreversible';
    expect(validate(toDecisionRecord(record))).toBe(false);
  });
});
