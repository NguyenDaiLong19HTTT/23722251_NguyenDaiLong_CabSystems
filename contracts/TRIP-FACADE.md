# Trip facade MVP slice — 2026-10-10

Source of truth: `API-Document/04-trip-api.yaml`, `RPC.md`,
`proto/cab/internal/v1/trip.proto`, `proto/cab/internal/v1/payment.proto`.
The separate Gateway contract is `proto/cab/gateway/v1/trip_facade.proto`;
`gateway-customer-policy.json` denies every unlisted facade method. Gateway
cannot call `PrepareTrip`, `ActivateTrip`, `CancelTripPreparation`, or Payment's
internal decision/fence. User token and mTLS service identity are checked
separately; IDs or statuses in client JSON never authorize an operation.

| REST API04 | Trip facade RPC | Authorization | Current delivery |
|---|---|---|---|
| GET `/v1/trips` | `ListMyTrips` | CUSTOMER/DRIVER own history | Implemented; cursor bound to account/filter/limit, 15 min |
| GET `/v1/trips/{tripId}` | `GetTrip` | own Customer/assigned Driver/OPERATOR | Implemented |
| PATCH `/v1/trips/{tripId}/status` | `UpdateTripStatus` | assigned Driver only | Implemented through status/Payment gate; requires a real active Trip |
| POST `/v1/trips/{tripId}/cancel` | `CancelTrip` | owner Customer/assigned Driver/OPERATOR and reason policy | Implemented for pre-pickup states |
| GET `/v1/trips/{tripId}/closure` | `GetTripClosure` | same Trip read scope | Implemented; PROCESSING until release receipts |
| POST `/v1/operations/trips/{tripId}/resolve-error` | `ResolveTripError` | OPERATOR only | RESTORE/CLOSE with exact version and durable receipt/closure |

No client `Idempotency-Key` is required for these routes. Gateway generates a
command ID per mutation. Trip persists response receipts for internal commands
and local state transitions in the same transaction. A lost HTTP response must
be followed by GET/current-version before a new command. The public API does
not promise replay of a new HTTP request with the generated ID. `ResolveTripError`
is the exception: Trip derives a stable internal command ID from trip ID,
expected version, action, trimmed note and verified Operator ID, so the same
HTTP payload replays its committed snapshot. A changed payload cannot mutate
the restored/closed Trip. No client idempotency header is required.

`PICKED_UP → IN_PROGRESS → COMPLETED` uses the assigned Driver, ordered state
and expected version under the Trip row lock. Payment is not a prerequisite.
PricingSnapshot fixes the fare before the ride, while a new Fare/Payment is
created only after Trip COMPLETED. A new cancellation and pickup compete on the
same Trip row. After CANCELLED commits, a durable closure job retries the same
`RecordTripCancellation(tripId, closureOperationId)` until Payment records the
fence. Payment SUCCESS before the fence remains evidence and becomes review
required; no automatic refund is claimed. Cross-service transactions are not
assumed.

TripPreparation.ACTIVE is `DRIVER_ASSIGNED`, not ride start. `PrepareTrip`
verifies Booking assignment and Driver reservation. `ActivateTrip` verifies
Booking ACTIVATING, bound Customer guard, and bound Driver reservation. Since
Booking and guard/reservation owners run in Compose and the HTTP Booking→Trip
path has been exercised. API04 tracking/GPS handoff and Incident creation
have HTTP evidence. API07 ERROR restoration verifies Identity Account,
Driver/Vehicle/reservation and Customer guard before the Trip CAS. Abnormal
close commits Incident resolution, audit, receipt, outbox and closure together;
the worker retries release. `journey_metrics` records PENDING at completion
for manual review and does not recalculate the Payment fare. Automatic GPS
confidence thresholds and a manual confirmation endpoint remain unimplemented.
