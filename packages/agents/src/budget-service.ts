import {
  add,
  formatMoney,
  isGreater,
  subtract,
  type ConstraintSet,
  type Money,
  type TripPlan,
} from '@trip/shared';

/**
 * The Budget / Optimisation Service.
 *
 * Deliberately not an agent: money is arithmetic, and arithmetic is not
 * something to ask a language model. Given a plan and the traveller's
 * constraints this says, exactly, where the plan stands against the budget.
 *
 * Two rules from the product are enforced here and nowhere loosened:
 *  - A budget is a *guide* unless the traveller said "do not exceed". Over a
 *    guide, a plan is `over_guide`; over a firm limit it is `over_firm`, which
 *    the validation service turns into a blocker.
 *  - A plan is only ever called `within` when its counted total really is at or
 *    under the budget. And because a total leaves out anything no source could
 *    price, `complete` says whether it is the whole cost; "within budget" never
 *    hides the fact that some costs are not in the total.
 */

export type BudgetStatus =
  | 'no_budget'
  | 'within'
  | 'over_guide'
  | 'over_firm'
  /** Over a firm limit that the traveller explicitly agreed to go past. */
  | 'over_firm_waived';

export interface BudgetAssessment {
  status: BudgetStatus;
  total: Money;
  budget: Money | null;
  firm: boolean;
  /** How far over, when over. */
  overBy: Money | null;
  /** How far under, when within. */
  headroom: Money | null;
  components: Array<{ label: string; amount: Money }>;
  /** The components added up here, to be compared with what the engine reported. */
  componentsTotal: Money;
  /** The engine's total equals the sum of its own components. */
  consistent: boolean;
  /** Nothing was left out of the total for want of a price. */
  complete: boolean;
  /** What the total leaves out, by name. */
  notIncluded: string[];
}

export function assessBudget(plan: Pick<TripPlan, 'cost'>, constraints: ConstraintSet): BudgetAssessment {
  const { cost } = plan;
  const components = [
    { label: 'Transport', amount: cost.transport },
    { label: 'Taxes and fees', amount: cost.transportFees },
    { label: 'Accommodation', amount: cost.accommodation },
    { label: 'Local travel', amount: cost.localTransport },
    { label: 'Activities', amount: cost.activities },
    { label: 'Food', amount: cost.meals },
    { label: 'Other', amount: cost.other },
  ];
  const componentsTotal = add(...components.map((c) => c.amount));
  const consistent =
    componentsTotal.currency === cost.total.currency && componentsTotal.amount === cost.total.amount;

  const { total: budget, firm } = constraints.budget;
  const waived = constraints.waivers.some((w) => w.kind === 'max_total_budget');

  let status: BudgetStatus = 'no_budget';
  let overBy: Money | null = null;
  let headroom: Money | null = null;
  if (budget && budget.currency === cost.total.currency) {
    if (isGreater(cost.total, budget)) {
      overBy = subtract(cost.total, budget);
      status = firm ? (waived ? 'over_firm_waived' : 'over_firm') : 'over_guide';
    } else {
      headroom = subtract(budget, cost.total);
      status = 'within';
    }
  }

  return {
    status,
    total: cost.total,
    budget: budget ?? null,
    firm,
    overBy,
    headroom,
    components,
    componentsTotal,
    consistent,
    complete: cost.notIncluded.length === 0,
    notIncluded: cost.notIncluded.map((n) => n.label),
  };
}

/**
 * The budget position in plain words, written from the assessment alone. The
 * synthesis step uses this verbatim, so a plan's relationship to the budget is
 * never something a model gets to phrase.
 */
export function describeBudget(a: BudgetAssessment): string {
  const incomplete = a.complete ? '' : ` This does not include: ${a.notIncluded.join(', ')}.`;
  switch (a.status) {
    case 'no_budget':
      return `No budget was set.${incomplete}`;
    case 'within':
      return `The counted total is ${formatMoney(a.total)}, within your budget of ${formatMoney(a.budget!)} with ${formatMoney(a.headroom!)} to spare.${incomplete}`;
    case 'over_guide':
      return `The counted total is ${formatMoney(a.total)}, which is ${formatMoney(a.overBy!)} over your budget of ${formatMoney(a.budget!)}. You said the budget is a guide, so the plan is shown, ranked lower.${incomplete}`;
    case 'over_firm':
      return `The counted total is ${formatMoney(a.total)}, which is ${formatMoney(a.overBy!)} over your firm limit of ${formatMoney(a.budget!)}, so this plan does not meet it.${incomplete}`;
    case 'over_firm_waived':
      return `The counted total is ${formatMoney(a.total)}, which is ${formatMoney(a.overBy!)} over your limit of ${formatMoney(a.budget!)}. You agreed to go over it for this plan.${incomplete}`;
  }
}
