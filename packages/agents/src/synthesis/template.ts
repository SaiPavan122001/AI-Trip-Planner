import type { PlanFact, SearchFacts } from './facts.js';

/**
 * The explanation written without a model: plain sentences assembled from the
 * facts. It is what a traveller gets when no model is configured, when the
 * model is down, and, item by item, whenever the model's text fails the
 * fact-check. Dull but true, which is the right trade.
 */

export interface Narrative {
  summary: string;
  /** One paragraph per plan, by plan id. */
  plans: Record<string, string>;
  /** `model` only if every part came from the model and passed the check. */
  source: 'model' | 'template' | 'mixed';
}

export function planText(fact: PlanFact): string {
  const parts: string[] = [];
  if (!fact.valid) {
    parts.push(`${fact.label} cannot be carried out as it stands: ${fact.blockers.join(' ') || 'it failed a check.'}`);
  } else {
    parts.push(`${fact.label} costs ${fact.total} in total, ${fact.perPerson} per person.`);
  }
  if (fact.outbound) parts.push(`Going: ${fact.outbound}.`);
  if (fact.returnLeg) parts.push(`Coming back: ${fact.returnLeg}.`);
  if (fact.stay) parts.push(`Staying at ${fact.stay}.`);
  parts.push(fact.budget);
  if (fact.valid && fact.warnings.length > 0) parts.push(`Worth knowing: ${fact.warnings.join(' ')}`);
  if (fact.tradeoffs.length > 0) parts.push(`Trade-offs: ${fact.tradeoffs.join(' ')}`);
  return parts.join(' ');
}

export function summaryText(facts: SearchFacts): string {
  const lines: string[] = [];
  const recommended = facts.plans.find((p) => p.planId === facts.recommendedPlanId);
  if (facts.plans.length === 0) {
    lines.push(`No plan could be built for ${facts.trip}.`);
    if (facts.notes.length > 0) lines.push(facts.notes.join(' '));
  } else if (!recommended) {
    lines.push(`For ${facts.trip}, none of the plans found can be carried out as they stand. Each one says why.`);
  } else {
    lines.push(`For ${facts.trip}, ${recommended.label} is the plan that best fits what you asked for, at ${recommended.total} in total.`);
    lines.push(recommended.budget);
  }
  if (facts.pinsReleased.length > 0) {
    lines.push(`Some things you asked to keep could not be kept: ${facts.pinsReleased.join(' ')}`);
  }
  if (facts.unsatisfiedPreferences.length > 0) {
    lines.push(facts.unsatisfiedPreferences.join(' '));
  }
  lines.push('Nothing has been booked or charged.');
  return lines.join(' ');
}

export function templateNarrative(facts: SearchFacts): Narrative {
  return {
    summary: summaryText(facts),
    plans: Object.fromEntries(facts.plans.map((p) => [p.planId, planText(p)])),
    source: 'template',
  };
}
