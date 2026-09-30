# Provider fixtures

These JSON files are the canned answers the provider contract tests serve in place of the network.

**They are hand-written from each vendor's public API documentation. They are not recordings of live
responses**, because no live credentials are used anywhere in this repository. That has two
consequences worth stating plainly:

- They prove the adapters map the *documented* shape correctly and fail safely on everything else.
  They do not prove a vendor still answers in that shape today.
- Amadeus enum values (cancellation policy, board type) and Nominatim/Google field details are as the
  documentation describes them and remain "not live-verified" in `PROJECT_STATUS.md`.

When someone with credentials records real responses, replace the file, keep the name, and the same
tests will tell them whether the adapter still maps it. Keep any recording free of personal data and
of the credentials it was made with.

All prices are in INR because the planner works in Indian rupees only.

| File | Serves |
|---|---|
| `amadeus/token.json` | `POST /v1/security/oauth2/token` |
| `amadeus/flight-offers.json` | `GET /v2/shopping/flight-offers` (two offers) |
| `amadeus/airports.json` | `GET /v1/reference-data/locations/airports` |
| `amadeus/hotels-by-geocode.json` | `GET /v1/reference-data/locations/hotels/by-geocode` |
| `amadeus/hotel-offers.json` | `GET /v3/shopping/hotel-offers` (two properties) |
| `osrm/route.json` | `GET /route/v1/driving/...` |
| `osrm/no-route.json` | The same, for two points no road joins |
| `nominatim/search.json` | `GET /search` (Hyderabad) |
| `google/places.json` | `POST /v1/places:searchNearby` |
| `google/routes.json` | `POST /directions/v2:computeRoutes` |
| `surface/rail.json` | `POST /search/trains` on the documented surface-transport contract |
