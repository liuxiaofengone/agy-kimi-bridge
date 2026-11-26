export type BridgeRuntimeStatus =
  | 'idle'
  | 'running'
  | 'awaiting_approval'
  | 'awaiting_question'
  | 'aborted'
  | 'failed';

export interface SessionStateFacts {
  status?: unknown;
  busy?: unknown;
  activity?: unknown;
  pending_interaction?: unknown;
  last_turn_reason?: unknown;
  last_turn_outcome?: unknown;
}

const LEGACY_STATUSES = new Set<BridgeRuntimeStatus>([
  'idle',
  'running',
  'awaiting_approval',
  'awaiting_question',
  'aborted',
  'failed',
]);

function unsupported(facts: SessionStateFacts): Error {
  const fields = Object.keys(facts).sort().join(', ') || '(none)';
  return new Error(`Unsupported Kimi session state fields: ${fields}`);
}

function normalizeIdleOutcome(facts: SessionStateFacts, outcome: unknown): BridgeRuntimeStatus {
  if (outcome === undefined || outcome === 'completed') return 'idle';
  if (outcome === 'cancelled' || outcome === 'interrupted') return 'aborted';
  if (outcome === 'failed') return 'failed';
  throw unsupported(facts);
}

export function normalizeRuntimeStatus(facts: SessionStateFacts): BridgeRuntimeStatus {
  if (typeof facts.status === 'string' && LEGACY_STATUSES.has(facts.status as BridgeRuntimeStatus)) {
    return facts.status as BridgeRuntimeStatus;
  }

  if (facts.pending_interaction === 'approval') return 'awaiting_approval';
  if (facts.pending_interaction === 'question') return 'awaiting_question';
  if (facts.pending_interaction !== undefined && facts.pending_interaction !== 'none') {
    throw unsupported(facts);
  }

  if (facts.activity !== undefined) {
    if (facts.activity === 'turn' || facts.activity === 'background') return 'running';
    if (facts.activity !== 'idle') throw unsupported(facts);
    return normalizeIdleOutcome(facts, facts.last_turn_outcome ?? facts.last_turn_reason);
  }

  if (facts.busy === true) return 'running';
  if (facts.busy !== false) throw unsupported(facts);

  return normalizeIdleOutcome(facts, facts.last_turn_reason ?? facts.last_turn_outcome);
}
