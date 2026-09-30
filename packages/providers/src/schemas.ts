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

const AmadeusEndpoint = z.object({
  iataCode: z.string().min(2).max(4),
  terminal: z.string().optional(),
  at: LocalDateTime,
});

export const AmadeusFlightOffer = z.object({
  id: z.string().min(1),
  itineraries: z
    .array(
      z.object({
        duration: z.string(),
        segments: z
          .array(
            z.object({
              departure: AmadeusEndpoint,
              arrival: AmadeusEndpoint,
              carrierCode: z.string().min(1),
              number: z.string().min(1),
              aircraft: z.object({ code: z.string() }).optional(),
              duration: z.string().optional(),
              numberOfStops: z.number().optional(),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
  price: z.object({
    currency: Currency,
    total: Amount,
    base: Amount.optional(),
    grandTotal: Amount.optional(),
    fees: z.array(z.object({ amount: Amount, type: z.string() })).optional(),
  }),
  numberOfBookableSeats: z.number().int().optional(),
  travelerPricings: z
    .array(
      z.object({
        price: z.object({ total: Amount, currency: Currency }),
        fareDetailsBySegment: z.array(
          z.object({
            cabin: z.string().optional(),
            class: z.string().optional(),
            includedCheckedBags: z
              .object({ quantity: z.number().optional(), weight: z.number().optional() })
              .optional(),
          }),
        ),
      }),
    )
    .optional(),
  pricingOptions: z.object({ refundableFare: z.boolean().optional() }).optional(),
});
export type AmadeusFlightOffer = z.infer<typeof AmadeusFlightOffer>;

export const AmadeusFlightSearchResponse = z.object({
  data: z.array(z.unknown()),
  dictionaries: z.object({ carriers: z.record(z.string(), z.string()).optional() }).optional(),
});

export const AmadeusPricingResponse = z.object({
  data: z.object({ flightOffers: z.array(z.unknown()) }),
});

export const AmadeusAirport = z.object({
  iataCode: z.string().min(2).max(4),
  name: z.string(),
  geoCode: z.object({ latitude: Latitude, longitude: Longitude }).optional(),
  distance: z.object({ value: z.number().nonnegative(), unit: z.string() }).optional(),
});
export const AmadeusAirportsResponse = z.object({ data: z.array(z.unknown()) });

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
