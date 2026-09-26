import {
  compare,
  hasBlockers,
  type HotelOffer,
  type Money,
  type TransportOffer,
  type TripPlan,
} from '@trip/shared';
import type { ScoredCandidate } from './scoring.js';

/**
 * How well a whole plan matches what the traveller ranked as important.
 *
 * A trip is a journey and a stay, and either can make it good or bad, so both
 * count. Each is scored by the scorer that already existed for it, against
 * every option found in the search, with the traveller's own ranked
 * priorities and the same weighting. The plan's score is the mean of the two,
 * so the journey and the stay have equal say; a plan with only one of them
 * (a day trip, or no hotel could be found) is scored on that one.
 *
 * Nothing here invents a new scale. If the two should ever count unequally,
 * that is one number to change, in one place.
 */
export function combinePlanScore(parts: {
  journey: ScoredCandidate<TransportOffer> | undefined;
  stay: ScoredCandidate<HotelOffer> | undefined;
}): { score: number; breakdown: Record<string, number> } {
  const scores: number[] = [];
  const breakdown: Record<string, number> = {};
  if (parts.journey) {
    scores.push(parts.journey.score);
    for (const [k, v] of Object.entries(parts.journey.breakdown)) breakdown[`journey.${k}`] = v;
  }
  if (parts.stay) {
    scores.push(parts.stay.score);
    for (const [k, v] of Object.entries(parts.stay.breakdown)) breakdown[`stay.${k}`] = v;
  }
  if (scores.length === 0) return { score: 0.5, breakdown };
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  return { score: Number(mean.toFixed(4)), breakdown };
}

/** The lowest a plan's score is scaled to for costing far more than its budget. */
const MIN_OVERSHOOT_FACTOR = 0.3;

/**
 * A budget the traveller called a guide is not a wall, but it is not nothing:
 * a plan that costs more than it is scaled down in proportion to how far over
 * it goes (10% over keeps 90% of its score, 50% over keeps half), never below
 * 30%, so a plan that is worth it can still win. Within the budget the factor
 * is 1. A firm budget does not use this: it filters and blocks instead.
 */
export function budgetOvershootFactor(total: Money, budget: Money | null, firm: boolean): number {
  if (!budget || firm || budget.currency !== total.currency || budget.amount <= 0) return 1;
  if (compare(total, budget) <= 0) return 1;
  const overshoot = (total.amount - budget.amount) / budget.amount;
  return Math.max(MIN_OVERSHOOT_FACTOR, 1 - overshoot);
}

/**
 * Best first. A plan the validator says cannot be carried out never outranks
 * one that can, whatever its score; within each group, higher scores lead.
 */
export function rankPlans(plans: TripPlan[]): void {
  plans.sort((a, b) => {
    const blocked = Number(hasBlockers(a)) - Number(hasBlockers(b));
    return blocked !== 0 ? blocked : b.priorityScore - a.priorityScore;
  });
}
