import {
  haversineKm,
  type JourneyClassification,
  type Place,
  type TransportMode,
} from '@trip/shared';

/**
 * Journey classification decides what the rest of the planner is even allowed
 * to search. It runs before any question about budget or style, because
 * "would you like a train?" is a nonsense question for Hyderabad to Paris and
 * "which airline?" is an expensive one for Hyderabad to Warangal.
 *
 * Every exclusion carries a reason string that is shown to the traveller. The
 * planner does not quietly drop options.
 */

/**
 * Regions within which a surface journey between two countries is actually
 * routine. Sharing a landmass is not enough: India and France sit on the same
 * continental plate, and there is still no sane way to take a train between
 * them. These groupings are about whether ordinary cross-border road and rail
 * travel exists, which is the question that decides whether searching a
 * surface provider is worth a request.
 *
 * Being wrong in the permissive direction costs one provider call that returns
 * `no_availability`. Being wrong in the restrictive direction hides a real
 * option, so `ADJACENT_REGIONS` and `FIXED_LINKS` below exist to catch the
 * crossings that genuinely work.
 */
const REGION: Record<string, string[]> = {
  europe: [
    'AL','AD','AT','BY','BE','BA','BG','HR','CZ','DK','EE','FI','FR','DE','GR','HU','IT','XK','LV','LI','LT','LU','MK','MD','MC','ME','NL','NO','PL','PT','RO','RU','SM','RS','SK','SI','ES','SE','CH','TR','UA','VA','GB','IE',
  ],
  middle_east: ['AM','AZ','GE','IR','IQ','IL','JO','KW','LB','OM','PS','QA','SA','SY','AE','YE','BH'],
  central_asia: ['KZ','KG','TJ','TM','UZ','AF','MN'],
  south_asia: ['BD','BT','IN','NP','PK','LK'],
  east_asia: ['CN','KP','KR','VN','LA','MM','TH','KH','MY','SG'],
  north_america: ['CA','US','MX','GT','BZ','SV','HN','NI','CR','PA'],
  south_america: ['CO','VE','EC','PE','BR','BO','PY','UY','AR','CL','GY','SR','GF'],
  north_africa: ['DZ','EG','LY','MA','TN','SD','MR'],
  sub_saharan_africa: [
    'AO','BJ','BW','BF','BI','CM','CF','TD','CG','CD','CI','DJ','GQ','ER','SZ','ET','GA','GM','GH','GN','GW','KE','LS','LR','MW','ML','MZ','NA','NE','NG','RW','SN','SL','SO','ZA','SS','TZ','TG','UG','ZM','ZW',
  ],
  oceania: ['AU','PG'],
  /** Islands with no land border at all. Surface travel out is by sea only. */
  island: ['IS','JP','PH','NZ','CU','JM','DO','HT','MG','MU','MV','CY','MT','TW','ID','BN'],
};

function regionOf(countryCode: string): string | null {
  const cc = countryCode.toUpperCase();
  for (const [region, members] of Object.entries(REGION)) {
    if (members.includes(cc)) return region;
  }
  return null;
}

/** Region pairs joined by routine cross-border road and rail traffic. */
const ADJACENT_REGIONS: Array<[string, string]> = [
  ['europe', 'middle_east'],
  ['middle_east', 'central_asia'],
  ['central_asia', 'south_asia'],
  ['central_asia', 'east_asia'],
  ['east_asia', 'south_asia'],
  ['north_africa', 'sub_saharan_africa'],
  ['north_africa', 'middle_east'],
  ['north_america', 'south_america'],
];

/** Country pairs with a usable fixed link or vehicle ferry of their own. */
const FIXED_LINKS: Array<[string, string]> = [
  ['GB', 'FR'],
  ['GB', 'IE'],
  ['DK', 'SE'],
  ['MY', 'SG'],
  ['ID', 'MY'],
  ['JP', 'KR'],
];

function hasFixedLink(a: string, b: string): boolean {
  return FIXED_LINKS.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

function regionsAdjacent(a: string, b: string): boolean {
  return ADJACENT_REGIONS.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

/**
 * Distance thresholds. These are about human tolerance, not geography: a
 * 14-hour bus is a legitimate option in many places and an absurd one beyond a
 * certain range, and offering a 2000km taxi wastes the traveller's attention.
 */
const MAX_BUS_KM = 1200;
const MAX_RAIL_KM = 3000;
const MAX_TAXI_KM = 400;
const MAX_SELF_DRIVE_KM = 2000;
const MIN_FLIGHT_KM = 150;

export interface ClassifyOptions {
  /** Modes the traveller has already ruled out; excluded with their own reason. */
  excludedByTraveler?: TransportMode[];
}

export function classifyJourney(
  origin: Place,
  destination: Place,
  opts: ClassifyOptions = {},
): JourneyClassification {
  const originCountry = origin.countryCode.toUpperCase();
  const destinationCountry = destination.countryCode.toUpperCase();
  const scope = originCountry === destinationCountry ? 'domestic' : 'international';
  const km = Math.round(haversineKm(origin.coordinates, destination.coordinates));

  const originRegion = regionOf(originCountry);
  const destRegion = regionOf(destinationCountry);
  const surfaceRoutePlausible =
    originCountry === destinationCountry ||
    hasFixedLink(originCountry, destinationCountry) ||
    (originRegion !== null &&
      destRegion !== null &&
      originRegion !== 'island' &&
      destRegion !== 'island' &&
      (originRegion === destRegion || regionsAdjacent(originRegion, destRegion)));

  const eligible: TransportMode[] = [];
  const excluded: Array<{ mode: TransportMode; reason: string }> = [];
  const ruledOut = new Set(opts.excludedByTraveler ?? []);

  const consider = (mode: TransportMode, allowed: boolean, reason: string) => {
    if (ruledOut.has(mode)) {
      excluded.push({ mode, reason: 'You asked not to include this mode.' });
      return;
    }
    if (allowed) eligible.push(mode);
    else excluded.push({ mode, reason });
  };

  consider(
    'flight',
    km >= MIN_FLIGHT_KM,
    `At ${km}km apart, flying costs more in airport time than it saves in the air.`,
  );

  if (scope === 'international' && !surfaceRoutePlausible) {
    const reason = `There is no practical surface route between ${origin.countryName} and ${destination.countryName}.`;
    for (const mode of ['train', 'bus', 'self_drive', 'taxi'] as TransportMode[]) {
      consider(mode, false, reason);
    }
    consider('rental_car', true, '');
    // A car hired at the destination is still useful once you have flown in.
    excluded.push({
      mode: 'ferry',
      reason: 'No scheduled vehicle ferry is known between these countries in this planner.',
    });
  } else {
    consider(
      'train',
      km <= MAX_RAIL_KM,
      `${km}km is beyond the range where rail competes with flying for this trip.`,
    );
    consider(
      'bus',
      km <= MAX_BUS_KM,
      `${km}km by road is too long for a scheduled coach to be a reasonable option.`,
    );
    consider(
      'self_drive',
      km <= MAX_SELF_DRIVE_KM,
      `${km}km is beyond a sensible self-drive range for this trip.`,
    );
    consider(
      'taxi',
      km <= MAX_TAXI_KM,
      `A private car for ${km}km would cost far more than any scheduled service.`,
    );
    consider('rental_car', km <= MAX_SELF_DRIVE_KM, `${km}km is beyond a sensible driving range.`);
    if (scope === 'international') {
      excluded.push({
        mode: 'ferry',
        reason: 'Ferry schedules are not covered by any connected provider.',
      });
    }
  }

  const documentationNotes: string[] = [];
  if (scope === 'international') {
    documentationNotes.push(
      `This is an international journey from ${origin.countryName} to ${destination.countryName}. Check passport validity, visa requirements and any transit-country rules with the official authorities for your nationality; this planner does not provide immigration advice.`,
    );
    if (origin.timezone !== destination.timezone) {
      documentationNotes.push(
        `Local time differs between ${origin.name} and ${destination.name}. All times in your itinerary are shown in the local time of the place they happen.`,
      );
    }
  }

  return {
    scope,
    originCountry,
    destinationCountry,
    greatCircleKm: km,
    crossesTimezones: origin.timezone !== destination.timezone,
    originTimezone: origin.timezone,
    destinationTimezone: destination.timezone,
    surfaceRoutePlausible,
    eligibleModes: eligible,
    excludedModes: excluded,
    documentationNotes,
  };
}
