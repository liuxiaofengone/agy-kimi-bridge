import { describe, expect, it } from 'vitest';
import { normalizeRuntimeStatus } from '../src/kimi/runtime-status.js';

describe('normalizeRuntimeStatus', () => {
  it.each([
    [{ status: 'idle' }, 'idle'],
    [{ status: 'running' }, 'running'],
    [{ status: 'awaiting_approval' }, 'awaiting_approval'],
    [{ status: 'awaiting_question' }, 'awaiting_question'],
    [{ status: 'aborted' }, 'aborted'],
    [{ status: 'failed' }, 'failed'],
    [{ busy: true, pending_interaction: 'none' }, 'running'],
    [{ busy: true, pending_interaction: 'approval' }, 'awaiting_approval'],
    [{ busy: true, pending_interaction: 'question' }, 'awaiting_question'],
    [{ busy: false, pending_interaction: 'none', last_turn_reason: 'completed' }, 'idle'],
    [{ busy: false, pending_interaction: 'none', last_turn_reason: 'cancelled' }, 'aborted'],
    [{ busy: false, pending_interaction: 'none', last_turn_reason: 'failed' }, 'failed'],
    [{ busy: false, pending_interaction: 'none' }, 'idle'],
    [{ status: 'running', busy: false, last_turn_reason: 'completed' }, 'running'],
    [{ activity: 'idle', pending_interaction: 'none' }, 'idle'],
    [{ activity: 'idle' }, 'idle'],
    [{ activity: 'turn', pending_interaction: 'none' }, 'running'],
    [{ activity: 'background', pending_interaction: 'none' }, 'running'],
    [{ activity: 'turn', pending_interaction: 'approval' }, 'awaiting_approval'],
    [{ activity: 'turn', pending_interaction: 'question' }, 'awaiting_question'],
    [{ activity: 'idle', pending_interaction: 'approval' }, 'awaiting_approval'],
    [{ activity: 'idle', pending_interaction: 'none', last_turn_outcome: 'completed' }, 'idle'],
    [{ activity: 'idle', pending_interaction: 'none', last_turn_outcome: 'interrupted' }, 'aborted'],
    [{ activity: 'idle', pending_interaction: 'none', last_turn_outcome: 'failed' }, 'failed'],
  ] as const)('normalizes %o to %s', (input, expected) => {
    expect(normalizeRuntimeStatus(input)).toBe(expected);
  });

  it.each([
    {},
    { status: 'paused' },
    { busy: 'yes' },
    { busy: false, pending_interaction: 'confirm' },
    { busy: false, pending_interaction: 'none', last_turn_reason: 'unknown' },
    { activity: 'paused' },
    { activity: 'idle', pending_interaction: 'confirm' },
    { activity: 'idle', pending_interaction: 'none', last_turn_outcome: 'unknown' },
  ])('rejects an unrecognized state shape: %o', (input) => {
    expect(() => normalizeRuntimeStatus(input)).toThrow(/Kimi session state|fields/);
  });

  it('does not include state values in its compatibility error', () => {
    expect(() => normalizeRuntimeStatus({ status: 'secret-value' })).toThrow(
      'Unsupported Kimi session state fields: status',
    );
  });
});
