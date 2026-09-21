import { describe, expect, it } from 'vitest';
import { interpretModificationByRules } from '../tasks.js';

/**
 * The deterministic fallback runs whenever no model is configured or the model
 * is unavailable, so its behaviour is a product guarantee rather than a
 * convenience. The most important property is the last one tested here: it
 * would rather admit it did not understand than act on a guess.
 */
describe('rule-based modification interpretation', () => {
  it('reads a request to spend less as a re-prioritisation', () => {
    const { request } = interpretModificationByRules('can you make it cheaper?');
    expect(request.intent).toBe('reduce_cost');
  });

  it('reads a request for something nicer as a comfort change', () => {
    expect(interpretModificationByRules('I want a more comfortable trip').request.intent).toBe(
      'increase_comfort',
    );
  });

  it('extracts a star rating when one is named', () => {
    const { request } = interpretModificationByRules('find me a 5-star hotel');
    expect(request.intent).toBe('change_hotel_tier');
    expect(request.parameters['category']).toBe(5);
  });

  it('identifies a mode switch and which mode', () => {
    const { request } = interpretModificationByRules('use the train instead');
    expect(request.intent).toBe('change_transport_mode');
    expect(request.parameters['mode']).toBe('train');
  });

  it('does not read a passing mention of a mode as a request to switch to it', () => {
    // "the flight is fine" names a mode but asks for nothing.
    const { request } = interpretModificationByRules('the flight is fine');
    expect(request.intent).not.toBe('change_transport_mode');
  });

  it('recognises a refusal of overnight travel', () => {
    expect(interpretModificationByRules("I don't want overnight travel").request.intent).toBe(
      'avoid_overnight',
    );
  });

  it('pins a component the traveller asked to keep', () => {
    const { request } = interpretModificationByRules('make it cheaper but keep the same hotel');
    expect(request.intent).toBe('reduce_cost');
    expect(request.pinnedComponents).toContain('hotel');
  });

  it('turns a safety request into an explicit priority order', () => {
    const { request } = interpretModificationByRules('prioritise safety over price');
    expect(request.intent).toBe('reprioritise');
    expect(request.parameters['priorities']).toEqual([
      'safest',
      'most_comfortable',
      'cheapest',
    ]);
  });

  it('keeps the traveller’s own words for the audit trail', () => {
    const utterance = 'make it cheaper';
    expect(interpretModificationByRules(utterance).request.utterance).toBe(utterance);
  });

  it('returns unknown rather than guessing when it does not understand', () => {
    // A wrong guess would silently re-search and replace parts of a plan the
    // traveller was happy with, so ambiguity must stop the machine.
    for (const nonsense of ['asdkjh qwe', 'hmm', 'what about that thing', '']) {
      const { request, interpretation } = interpretModificationByRules(nonsense);
      expect(request.intent, nonsense).toBe('unknown');
      expect(interpretation).toMatch(/nothing has changed/i);
    }
  });
});
