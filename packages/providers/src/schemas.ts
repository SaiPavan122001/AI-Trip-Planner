import { z } from 'zod';

/**
 * The shape each vendor's answer must have before an adapter maps it.
 *
 * These describe only the fields the adapters read, taken from each vendor's
 * public documentation; they are not a full model of the vendor's API, and
 * fields a vendor adds later are ignored rather than rejected. What they do
 * refuse is the thing that used to reach the mapping code unchecked: a missing
 * list, a price that is not a number, a coordinate that is not a coordinate.
 * That is reported as an unusable response, at the boundary.
 *
 * They have been checked against hand-written fixtures in `__tests__/fixtures`,
 * not against live vendor responses (see docs/providers.md).
 */

/** A money amount as vendors send it: a decimal string ("24000.00"), never negative. */
const Amount = z
  .string()
  .refine((v) => v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0, 'not a non-negative amount');
const Currency = z.string().length(3);
const Latitude = z.number().min(-90).max(90);
const Longitude = z.number().min(-180).max(180);
const LocalDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, 'not a date and time');
const Rating = z.union([z.string(), z.number()]);

// ------------------------------------------------------------------ Amadeus

export const AmadeusToken = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

export const AmadeusHotel = z.object({
  hotelId: z.string().min(1),
  name: z.string(),
  geoCode: z.object({ latitude: Latitude, longitude: Longitude }),
  address: z
    .object({ countryCode: z.string().optional(), lines: z.array(z.string()).optional(), cityName: z.string().optional() })
    .optional(),
  rating: Rating.optional(),
  amenities: z.array(z.string()).optional(),
});
export type AmadeusHotel = z.infer<typeof AmadeusHotel>;
export const AmadeusHotelListResponse = z.object({ data: z.array(z.unknown()) });

export const AmadeusHotelOffer = z.object({
  hotel: z.object({
    hotelId: z.string().min(1),
    name: z.string(),
    rating: Rating.optional(),
    latitude: Latitude.optional(),
    longitude: Longitude.optional(),
    amenities: z.array(z.string()).optional(),
    address: z.object({ lines: z.array(z.string()).optional(), cityName: z.string().optional() }).optional(),
  }),
  available: z.boolean(),
  offers: z.array(
    z.object({
      id: z.string().min(1),
      checkInDate: z.string(),
      checkOutDate: z.string(),
      boardType: z.string().optional(),
      room: z
        .object({
          type: z.string().optional(),
          typeEstimated: z
            .object({ category: z.string().optional(), beds: z.number().optional(), bedType: z.string().optional() })
            .optional(),
          description: z.object({ text: z.string().optional() }).optional(),
        })
        .optional(),
      guests: z.object({ adults: z.number().optional() }).optional(),
      price: z.object({
        currency: Currency,
        base: Amount.optional(),
        total: Amount,
        taxes: z.array(z.object({ included: z.boolean().optional() })).optional(),
      }),
      policies: z
        .object({
          cancellations: z
            .array(
              z.object({
                deadline: z.string().optional(),
                description: z.object({ text: z.string().optional() }).optional(),
                amount: z.string().optional(),
              }),
            )
            .optional(),
          refundable: z.object({ cancellationRefund: z.string().optional() }).optional(),
        })
        .optional(),
    }),
  ),
});
export type AmadeusHotelOffer = z.infer<typeof AmadeusHotelOffer>;
export const AmadeusHotelOffersResponse = z.object({
  data: z.array(z.unknown()),
  warnings: z.array(z.object({ detail: z.string().optional() })).optional(),
});
export const AmadeusSingleHotelOfferResponse = z.object({ data: z.unknown() });

// ------------------------------------------------------------------- Duffel
//
// Taken from https://duffel.com/docs/api: an offer request is answered with
// `data.offers`; amounts are decimal strings; segment times carry no offset
// (they are local to the airport). Only the fields the adapter reads are listed.

const DuffelAirport = z.object({
  iata_code: z.string().min(2).max(4),
  name: z.string().optional(),
  latitude: z.number().nullish(),
  longitude: z.number().nullish(),
  time_zone: z.string().nullish(),
});

const DuffelCarrier = z.object({
  iata_code: z.string().min(2).max(3).nullish(),
  name: z.string().nullish(),
});

export const DuffelOffer = z.object({
  id: z.string().min(1),
  total_amount: Amount,
  total_currency: Currency,
  expires_at: z.string().nullish(),
  owner: DuffelCarrier.nullish(),
  passengers: z.array(z.unknown()).nullish(),
  slices: z
    .array(
      z.object({
        duration: z.string().nullish(),
        segments: z
          .array(
            z.object({
              marketing_carrier: DuffelCarrier,
              operating_carrier: DuffelCarrier.nullish(),
              marketing_carrier_flight_number: z.string().min(1),
              origin: DuffelAirport,
              destination: DuffelAirport,
              origin_terminal: z.string().nullish(),
              destination_terminal: z.string().nullish(),
              departing_at: LocalDateTime,
              arriving_at: LocalDateTime,
              duration: z.string().nullish(),
              aircraft: z.object({ name: z.string().nullish(), iata_code: z.string().nullish() }).nullish(),
              passengers: z
                .array(
                  z.object({
                    cabin_class: z.string().nullish(),
                    cabin_class_marketing_name: z.string().nullish(),
                    fare_basis_code: z.string().nullish(),
                    baggages: z.array(z.object({ type: z.string(), quantity: z.number() })).nullish(),
                  }),
                )
                .nullish(),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
  conditions: z
    .object({
      refund_before_departure: z
        .object({
          allowed: z.boolean(),
          penalty_amount: z.string().nullish(),
          penalty_currency: z.string().nullish(),
        })
        .nullish(),
    })
    .nullish(),
});
export type DuffelOffer = z.infer<typeof DuffelOffer>;

export const DuffelOfferRequestResponse = z.object({
  data: z.object({ offers: z.array(z.unknown()) }),
});

export const DuffelSingleOfferResponse = z.object({ data: z.unknown() });

export const DuffelPlace = z.object({
  type: z.string(),
  iata_code: z.string().min(2).max(4),
  name: z.string(),
  latitude: Latitude.nullish(),
  longitude: Longitude.nullish(),
});
export const DuffelPlacesResponse = z.object({ data: z.array(z.unknown()) });

// --------------------------------------------------------------- Hotelbeds
//
// From https://developer.hotelbeds.com/documentation. Hotelbeds sends amounts
// and coordinates as strings in some places and numbers in others, so both are
// read. Only the fields the adapters use are listed; Hotelbeds' own examples
// were the reference, not a recorded response.

const HbNumberLike = z.union([z.string(), z.number()]);
const HbAmount = HbNumberLike.refine(
  (v) => String(v).trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0,
  'not a non-negative amount',
);
const HbCoordinate = HbNumberLike.refine((v) => Number.isFinite(Number(v)), 'not a coordinate');

export const HotelbedsRate = z.object({
  rateKey: z.string().min(1),
  rateClass: z.string().nullish(),
  rateType: z.string().nullish(),
  net: HbAmount,
  sellingRate: HbAmount.nullish(),
  hotelMandatory: z.boolean().nullish(),
  allotment: z.number().nullish(),
  paymentType: z.string().nullish(),
  packaging: z.boolean().nullish(),
  boardCode: z.string().nullish(),
  boardName: z.string().nullish(),
  rooms: z.number().int().positive().nullish(),
  adults: z.number().nullish(),
  children: z.number().nullish(),
  cancellationPolicies: z.array(z.object({ amount: HbAmount, from: z.string() })).nullish(),
  taxes: z
    .object({
      allIncluded: z.boolean().nullish(),
      taxes: z
        .array(
          z.object({
            included: z.boolean().nullish(),
            amount: HbAmount.nullish(),
            currency: z.string().nullish(),
            type: z.string().nullish(),
          }),
        )
        .nullish(),
    })
    .nullish(),
});
export type HotelbedsRate = z.infer<typeof HotelbedsRate>;

export const HotelbedsHotel = z.object({
  code: HbNumberLike,
  name: z.string(),
  categoryCode: z.string().nullish(),
  categoryName: z.string().nullish(),
  destinationName: z.string().nullish(),
  zoneName: z.string().nullish(),
  latitude: HbCoordinate.nullish(),
  longitude: HbCoordinate.nullish(),
  currency: z.string().length(3),
  rooms: z.array(
    z.object({
      code: z.string(),
      name: z.string().nullish(),
      rates: z.array(z.unknown()),
    }),
  ),
});
export type HotelbedsHotel = z.infer<typeof HotelbedsHotel>;

export const HotelbedsAvailabilityResponse = z.object({
  hotels: z.object({ hotels: z.array(z.unknown()).nullish() }).nullish(),
});
export const HotelbedsCheckRateResponse = z.object({ hotel: z.unknown() });

export const HotelbedsContentResponse = z.object({ hotels: z.array(z.unknown()).nullish() });
export const HotelbedsContentHotel = z.object({
  code: HbNumberLike,
  description: z.object({ content: z.string().nullish() }).nullish(),
  address: z.object({ content: z.string().nullish() }).nullish(),
  city: z.object({ content: z.string().nullish() }).nullish(),
});

export const HotelbedsActivity = z.object({
  activityCode: z.string().nullish(),
  currencyName: z.string().nullish(),
  content: z
    .object({
      code: z.string().nullish(),
      name: z.string().nullish(),
      currency: z.string().nullish(),
      activityCode: z.string().nullish(),
    })
    .nullish(),
  amountsFrom: z
    .array(z.object({ paxType: z.string(), amount: HbAmount.nullish() }))
    .nullish(),
  modalities: z
    .array(
      z.object({
        code: z.string().nullish(),
        name: z.string().nullish(),
        duration: z
          .union([HbNumberLike, z.object({ value: HbNumberLike.nullish(), metric: z.string().nullish() })])
          .nullish(),
        rates: z
          .array(
            z.object({
              rateCode: z.string().nullish(),
              rateClass: z.string().nullish(),
              freeCancellation: z.boolean().nullish(),
              rateDetails: z
                .array(
                  z.object({
                    totalAmount: z.object({ amount: HbAmount }).nullish(),
                  }),
                )
                .nullish(),
            }),
          )
          .nullish(),
      }),
    )
    .nullish(),
}).refine((a) => Boolean(a.activityCode ?? a.content?.code ?? a.content?.activityCode), 'an activity needs a code');
export type HotelbedsActivity = z.infer<typeof HotelbedsActivity>;
export const HotelbedsActivitiesResponse = z.object({ activities: z.array(z.unknown()).nullish() });

export const HotelbedsTransferService = z.object({
  id: z.number().or(z.string()),
  direction: z.string().nullish(),
  transferType: z.string().nullish(),
  vehicle: z.object({ code: z.string().nullish(), name: z.string().nullish() }).nullish(),
  category: z.object({ code: z.string().nullish(), name: z.string().nullish() }).nullish(),
  minPaxCapacity: z.number().nullish(),
  maxPaxCapacity: z.number().nullish(),
  rateKey: z.string().min(1),
  price: z.object({
    totalAmount: HbAmount,
    netAmount: HbAmount.nullish(),
    currencyId: z.string().length(3),
  }),
  cancellationPolicies: z
    .array(z.object({ amount: HbAmount.nullish(), from: z.string().nullish(), currencyId: z.string().nullish() }))
    .nullish(),
  content: z
    .object({
      transferDetailInfo: z
        .array(
          z.object({
            name: z.string().nullish(),
            description: z.string().nullish(),
            type: z.string().nullish(),
            value: HbNumberLike.nullish(),
            metric: z.string().nullish(),
          }),
        )
        .nullish(),
    })
    .nullish(),
});
export type HotelbedsTransferService = z.infer<typeof HotelbedsTransferService>;
export const HotelbedsTransfersResponse = z.object({ services: z.array(z.unknown()).nullish() });

// --------------------------------------------------------------------- OSRM

export const OsrmRouteResponse = z.object({
  code: z.string(),
  routes: z
    .array(
      z.object({
        distance: z.number().nonnegative(),
        duration: z.number().nonnegative(),
        geometry: z.string().optional(),
      }),
    )
    .optional(),
});

// ---------------------------------------------------------------- Nominatim

export const NominatimRow = z.object({
  place_id: z.union([z.number(), z.string()]),
  lat: z.union([z.string(), z.number()]),
  lon: z.union([z.string(), z.number()]),
  display_name: z.string(),
  name: z.string().optional(),
  address: z.record(z.string(), z.string()).optional(),
});
export type NominatimRow = z.infer<typeof NominatimRow>;
export const NominatimSearchResponse = z.array(z.unknown());

// ------------------------------------------------------------------- Google

const OpeningPoint = z.object({ day: z.number().int().min(0).max(6), hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) });

export const GooglePlace = z.object({
  id: z.string().min(1),
  displayName: z.object({ text: z.string() }).optional(),
  formattedAddress: z.string().optional(),
  location: z.object({ latitude: Latitude, longitude: Longitude }).optional(),
  types: z.array(z.string()).optional(),
  rating: z.number().optional(),
  userRatingCount: z.number().optional(),
  editorialSummary: z.object({ text: z.string() }).optional(),
  regularOpeningHours: z
    .object({
      periods: z.array(z.object({ open: OpeningPoint.optional(), close: OpeningPoint.optional() })).optional(),
    })
    .optional(),
  accessibilityOptions: z.record(z.string(), z.boolean()).optional(),
});
export type GooglePlace = z.infer<typeof GooglePlace>;
export const GooglePlacesResponse = z.object({ places: z.array(z.unknown()).optional() });

export const GoogleRoutesResponse = z.object({
  routes: z
    .array(
      z.object({
        distanceMeters: z.number().nonnegative().optional(),
        duration: z.string().regex(/^\d+(\.\d+)?s$/, 'not a duration in seconds').optional(),
        polyline: z.object({ encodedPolyline: z.string().optional() }).optional(),
      }),
    )
    .optional(),
});
