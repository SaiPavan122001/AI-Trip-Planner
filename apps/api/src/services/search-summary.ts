import type { PlanGenerationResult } from '@trip/engine';
import type { SearchSummary } from '@trip/shared';

/**
 * The mode comparison the UI shows before anyone picks a way of travelling.
 * Modes with nothing to show carry the reason why, so the screen can say
 * "no rail provider is connected" instead of silently omitting rail.
 */
function summariseSearch(search: PlanGenerationResult['transport']['outbound']) {
  return {
    date: search.date,
    modes: search.modes.map((m) => ({
      mode: m.mode,
      optionCount: m.offers.length,
      cheapest: m.cheapest,
      fastest: m.fastest,
      bestForYou: m.bestForYou,
      allOffers: m.offers.slice(0, 10),
      unavailableReason: m.note,
    })),
    filteredByYourRequirements: search.filtered,
  };
}

export function searchSummaryOf(result: PlanGenerationResult, builtAt: string): SearchSummary {
  return {
    builtAt,
    outbound: summariseSearch(result.transport.outbound),
    inbound: result.transport.inbound ? summariseSearch(result.transport.inbound) : null,
    hotelsConsidered: result.hotels.candidates.length,
    hotelsFiltered: result.hotels.filtered,
    budgetConflict: result.budgetConflict,
    feasibility: result.feasibility,
  };
}
