import type { AccessibilityNeed, HotelOffer } from '@trip/shared';

/**
 * Accessibility needs are hard requirements. The planner can only treat one
 * as met when a provider publishes something that actually states it; it
 * never infers access from a star rating, a price or silence.
 *
 * Each need is matched only against evidence for that need. A lift is not
 * step-free access, and "pets allowed" is not a promise about service
 * animals, so neither is accepted as one.
 */

/** Plain-language names, for reasons and warnings shown to the traveller. */
export const ACCESSIBILITY_LABEL: Record<AccessibilityNeed, string> = {
  step_free_access: 'step-free access',
  wheelchair_accessible_room: 'a wheelchair-accessible room',
  wheelchair_assistance_at_terminal: 'assistance at airports and stations',
  accessible_bathroom: 'an accessible bathroom',
  elevator_required: 'a lift',
  ground_floor_room: 'a ground-floor room',
  service_animal: 'service animals',
  visual_assistance: 'support for visual impairment',
  hearing_assistance: 'support for hearing impairment',
};

/**
 * What a property's published amenities must say for each need to count as
 * confirmed. Amenity strings arrive in provider formats such as
 * "WHEELCHAIR_ACCESS" or "Wheelchair accessible", so separators are loose.
 * Terminal assistance is a transport matter and has no hotel evidence.
 */
const HOTEL_EVIDENCE: Partial<Record<AccessibilityNeed, RegExp>> = {
  step_free_access: /step[\s_-]?free|level[\s_-]?access|wheelchair|ramp/i,
  wheelchair_accessible_room: /wheelchair|handicap|disab|accessible[\s_-]?room/i,
  accessible_bathroom: /accessible[\s_-]?(bath|shower|toilet)|roll[\s_-]?in[\s_-]?shower|grab[\s_-]?bars?/i,
  elevator_required: /elevator|(^|[\s_-])lifts?($|[\s_-])/i,
  ground_floor_room: /ground[\s_-]?floor/i,
  service_animal: /service[\s_-]?animals?|assistance[\s_-]?(dogs?|animals?)|guide[\s_-]?dogs?/i,
  visual_assistance: /braille|visual[\s_-]?(impair|assist)/i,
  hearing_assistance: /hearing|\btty\b|teletype|visual[\s_-]?alarm/i,
};

/** The needs a hotel has to satisfy; terminal assistance is not one of them. */
export function hotelRelevantNeeds(needs: readonly AccessibilityNeed[]): AccessibilityNeed[] {
  return needs.filter((n) => HOTEL_EVIDENCE[n] !== undefined);
}

/** The stated needs this property does not publish that it meets. */
export function unconfirmedHotelNeeds(
  hotel: Pick<HotelOffer, 'amenities'>,
  needs: readonly AccessibilityNeed[],
): AccessibilityNeed[] {
  return hotelRelevantNeeds(needs).filter(
    (need) => !hotel.amenities.some((amenity) => HOTEL_EVIDENCE[need]!.test(amenity)),
  );
}

export function describeNeeds(needs: readonly AccessibilityNeed[]): string {
  const labels = needs.map((n) => ACCESSIBILITY_LABEL[n]);
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}
