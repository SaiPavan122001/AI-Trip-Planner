# Booking

Booking is where a planning tool starts handling other people's money, so this part of the system is
deliberately the least clever. It is an explicit state machine with two invariants that are enforced
in code and covered by tests.

## The invariants

**1. A reservation exists only when a provider says so.**

`confirmed` and `ticketed` are the only states that assert a booking exists, and both are reachable
only through a `PROVIDER_*` event carrying a provider reference. `BookingService.apply` refuses the
transition otherwise:

> A booking cannot be marked confirmed without a reference from the provider. This is enforced so
> the system never tells a traveller they have a reservation that does not exist.

A test walks every declared transition and asserts that nothing reaching a confirmed state is
triggered by anything other than a provider response.

**2. The price is re-validated immediately before payment.**

`awaiting_confirmation` has exactly one transition onward, and it is `START_REVALIDATION`. A price
quoted twenty minutes ago is not a price anyone may be charged.

The pre-payment re-price has its own state, `revalidating_for_payment`, rather than reusing
`revalidating`. That is not ceremony: a shared state would have to decide where to return based on
where the booking came from, which the machine cannot know, and the failure mode of getting it
wrong is a stale price reaching a card.

## States

```
                          ┌──────────────── CANCEL ────────────────┐
                          │                                        ▼
  draft ──START_REVALIDATION──► revalidating ──REVALIDATION_OK──► revalidated ──► cancelled
                                     │                                 │
              REVALIDATION_PRICE_CHANGED│                              │ SUBMIT_TRAVELER_DETAILS
                                     ▼                                 ▼
                              price_changed                  traveler_details_pending
                                     │ ACCEPT_NEW_PRICE                │ SUBMIT_REVIEW
                                     └────────────►revalidated         ▼
                                                                 review_pending
                REVALIDATION_UNAVAILABLE│                              │ USER_CONFIRM
                                     ▼                                 ▼
                               unavailable                  awaiting_confirmation
                                                                       │
                                            ┌──── START_REVALIDATION ──┘
                                            ▼
                              revalidating_for_payment ──PRICE_CHANGED──► price_changed
                                            │ REVALIDATION_OK
                                            ▼
                                     payment_pending
                                            │ PAYMENT_AUTHORIZED
                                            ▼
                                    payment_authorized
                                            │ PROVIDER_BOOKING_STARTED
                                            ▼
                                     provider_booking
                                   ┌────────┴────────┐
                     PROVIDER_CONFIRMED         PROVIDER_FAILED
                            ▼                        ▼
                        confirmed                  failed
                            │ PROVIDER_TICKETED       │ REFUND_INITIATED
                            ▼                        ▼
                        ticketed ──CANCEL──► refund_pending ──REFUND_COMPLETED──► refunded
```

The machine is data, not control flow: `BOOKING_TRANSITIONS` in `packages/shared/src/booking.ts` is
a map from state to event to state, and `nextBookingState` is the only way to move. An event that is
not declared for the current state returns `409` naming the current state, which makes client bugs
obvious rather than silent.

## Idempotency

Every booking mutation requires an `Idempotency-Key` header of at least 8 characters. The repository
claims the key before doing any work and stores the response against it:

- First request with a key: the key is reserved with a null body, the work runs, the response is
  stored.
- Retry with the same key: the stored response is returned. No second booking.

The failure this protects against — a retried request creating two reservations — is one the
traveller pays for.

## Payment

Card data never reaches this service. Authorisation is expected to happen client-side against a
payment provider; the state machine accepts only the resulting authorisation reference. There is no
field anywhere in the schema for a card number, and there is no code path that would accept one.

`payment_authorized` means a PSP has authorised a charge, not that it has been captured. A booking
that fails at the provider step lands in `failed`, and the response says the charge should not be
captured.

## Ticketing, honestly

No shipped adapter is authorised to issue tickets. Amadeus Self-Service requires a separate
production agreement for its Flight Create Orders endpoint, and the rail and bus contracts are
search-only.

So `POST /v1/bookings/:id/confirm` is fully wired — it validates state, requires traveller details,
transitions through `provider_booking` — and then fails with:

> This deployment has no provider authorised to issue tickets, so no booking was made and no charge
> should be captured. Connect a booking-capable provider to enable this step.

That is the correct behaviour for a system that cannot actually book. Simulating a confirmation
would be the single most harmful thing this codebase could do.

## Traveller data

`TravelerDetails` includes names, dates of birth and optionally passport or national ID details,
because providers require them at booking time.

These are stored in their own table (`traveler_records`), separate from the planning session, so
retention and access rules apply in one enforceable place. The API never echoes them back — the
client already has them, and a response body is one more place for them to leak. The logger redacts
`*.document` and `travelers[*].document` paths, so a document number cannot reach a log line even by
accident.
