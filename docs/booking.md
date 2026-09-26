# Booking

**Booking is not available in this release.** Wayfare plans, compares and adjusts trips. It cannot
reserve, pay for or ticket anything, because it has no payment provider and no provider authorised
to issue tickets. It must never look as though it can.

Every booking endpoint is still registered, and answers `501` with `booking_unavailable`:

> Booking is not available yet. You can plan, compare and adjust trips here, and booking will be
> added in a later release. Nothing has been booked or charged.

These routes read no request body, write nothing and contact no provider. In particular
`POST /v1/trips/:id/travelers` does **not** store names, dates of birth or passport numbers: with no
booking to make there is nothing to use them for, and data that is never collected cannot leak.

The rest of this page describes code that exists and is tested but is **not reachable over HTTP**.
It is kept so the booking phase starts from a state machine with its safety properties already
enforced, not from a blank page.

---

## What exists in the code

### The state machine

`BOOKING_TRANSITIONS` in `packages/shared/src/booking.ts` is a map from state to event to state, and
`nextBookingState` is the only way to move. An event that is not declared for the current state is
refused with `409`.

```
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

### Who may send which event

Clients may originate only `SUBMIT_TRAVELER_DETAILS`, `SUBMIT_REVIEW`, `USER_CONFIRM`,
`ACCEPT_NEW_PRICE` and `CANCEL` (`CLIENT_BOOKING_EVENTS`). Everything else records a fact only a
provider or payment processor can know, so `BookingService.applyClientEvent` refuses it with `403`
whatever state the booking is in. Re-pricing, payment and provider outcomes can only come from the
service's own workflows: the general transition method is private.

A test walks the whole transition table and asserts that no client event can ever lead into a
payment or provider state. An earlier version of the API let a client post `PROVIDER_CONFIRMED` with
any reference it made up, and a test asserted that as correct; that is exactly what must not happen
again.

Two rules the machine encodes, and tests cover:

- **A reservation exists only when a provider says so.** `confirmed` and `ticketed` are reachable
  only through provider events carrying a provider reference.
- **The price is re-validated immediately before payment.** `awaiting_confirmation` has exactly one
  way onward, through `revalidating_for_payment`. A price quoted twenty minutes ago is not a price
  anyone may be charged.

### Re-pricing names the provider's offer

`revalidateFlight(token)` and `revalidateHotel(token)` take only the provider's own token, exactly as
the search returned it. Nothing from this system's own records, such as a booking id, is ever passed:
an earlier version passed the booking's UUID where Amadeus expected its offer id.

### Idempotency

A booking is created at most once per **(principal, operation, key)**:

- The key is claimed **atomically** before any work starts. In PostgreSQL that is one insert on the
  claim's primary key, so of any number of racing requests exactly one wins.
- A concurrent duplicate is told the work is in progress (`409`); a later retry receives the stored
  booking; the same key used for a *different* request is refused (`422`).
- One user's key can never see, block or replay another's, because the principal is part of the
  claim's identity.
- A failed attempt releases its claim so the client can retry. Once the booking exists the claim is
  never released, so failing to record the result cannot lead to a second booking.
- An unfinished claim lapses after five minutes and a finished one is kept for 24 hours.
- A booking transition is applied at most once: a save succeeds only if the booking is still in the
  state the request read, so two racing requests cannot both apply the same event.

The PostgreSQL behaviour is tested through a fake client that enforces the same unique keys. It has
not been run against a live database.

Only booking creation is deduplicated by key. Event and confirm calls are protected by the state
machine and the state check above, not by a stored response.

---

## What is not built

- **Payment.** Card data never reaches this service, and there is no field for it. The state machine
  would accept only an authorisation reference from a payment provider.
- **Ticketing.** No adapter is authorised to create orders. Amadeus Self-Service requires a separate
  production agreement for that.
- **Authentication.** Booking needs a real identity for every request. That does not exist yet, so
  `principal` is `null` everywhere. Enabling booking without it would make booking ids and idempotency
  keys the only thing standing between one person's trip and another's.
- **Traveller-data encryption.** `traveler_records` has `encrypted` and `nonce` columns, but the
  current code stores the serialised record unencrypted. Nothing writes to it while booking is off,
  and it must be implemented before booking is enabled.

Booking is a separate phase: it needs a payment provider, a booking-capable provider, identity, and
encryption of traveller documents chosen deliberately, not assembled from what is here.
