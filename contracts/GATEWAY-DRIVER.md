# Driver demo facade (API07 + API04 + API03)

This slice uses the existing public request/response/status definitions in
`API-Document/07-operations-api.yaml`, `API-Document/04-trip-api.yaml` and
`API-Document/03-dispatch driver-api.yaml`. The gRPC transport contract is
`proto/cab/gateway/v1/driver_facade.proto`; it is separate from all
`cab.internal.v1` service-to-service RPCs.

| HTTP Gateway route | Owner | Full facade method |
|---|---|---|
| `GET /v1/drivers/me` | Driver | `/cab.gateway.v1.DriverFacadeService/GetMyDriverProfile` |
| `GET /v1/drivers/{driverId}` | Driver | `/cab.gateway.v1.DriverFacadeService/GetDriverById` |
| `PUT /v1/drivers/me/availability` | Driver | `/cab.gateway.v1.DriverFacadeService/SetMyDriverAvailability` |
| `PUT /v1/drivers/me/location` | Driver | `/cab.gateway.v1.DriverFacadeService/UpdateMyDriverLocation` |
| `GET /v1/drivers/nearby` | Driver | `/cab.gateway.v1.DriverFacadeService/SearchNearbyDrivers` |

`gateway-customer-policy.json` is the existing facade policy file and now
contains these five exact Driver methods as well as the five Customer slice
methods. Caller identity comes from the verified Gateway client certificate
URI SAN, with default deny. The end-user bearer token travels separately in
request metadata. Driver verifies it through Identity and checks that the
Identity `driver_id`/`account_id` binding matches its own profile; Gateway
cannot turn claimed metadata into a caller identity. The internal 34-method
policy is unchanged. There is no plaintext fallback.

The Driver response maps its own profile and assigned vehicle fields to API07.
Identity owns Account/Session, and Driver never reads the Identity database.
Driver stores license number encrypted locally. Availability accepts only
`AVAILABLE` or `OFFLINE` in this demo, with required `expectedVersion`.
Gateway creates a command key when the client omits the optional legacy
`Idempotency-Key`; Driver still records the keyed receipt in the same
transaction. Without a client key, a second PUT uses current version and
state, not a promise to replay the first HTTP response. The update
locks the Driver/assignment/vehicle rows, checks approval, active vehicle and
a latest GPS point no older than 30 seconds before AVAILABLE in production.
In the development Compose demo only, a missing/stale point is replaced with
the configured fixed demo pickup location in the same transaction as the state
and receipt. This is synthetic location data, not device GPS; Dispatch still
requires a point no older than 30 seconds. OFFLINE is idempotent. API04 location updates store
the latest point and a durable sample at Driver; no map or dispatch worker is
part of this slice.

`GetDriverById` returns only `driverId` and current `fullName`. Driver owns the
Driver ID→Account ID binding; Identity supplies the current name and verifies
the user session. For CUSTOMER, Identity asks Trip whether that Customer has
ever been assigned a Trip with the target Driver account. DRIVER may read only
their own ID; OPERATOR may read any existing Driver. A missing or unauthorized
ID returns 404. Trip/Identity outages fail closed as 503. No license, contact,
vehicle, approval state or GPS enters this response. The older scaffold
restriction about missing Booking/Trip integration no longer applies to this
read route.

The API03 nearby route requires a currently valid CUSTOMER or OPERATOR session.
It accepts latitude, longitude, optional radiusKm (default 1, at most 5),
limit (default 20, at most 100) and cursor. Driver filters approved AVAILABLE
profiles, active assigned vehicles, GPS no older than 30 seconds and ACTIVE
Identity accounts. Haversine distance is used without rounding for filtering
and sorting; only driverId, vehicleType and distance floored to 10 metres
leave the service. The 30-second Driver-owned snapshot fixes pagination
results; cursor is bound to account and search parameters. This is discovery,
not a reservation or proof that a Driver can accept a Trip later. The new
migration, handler and facade are source changes awaiting HTTP/Compose
verification; they are not a deployed Booking flow.

## Registration and review demo extension

The additive facade in `proto/cab/gateway/v1/driver_registration_facade.proto`
uses API07 as its public baseline and the existing Identity/Driver ownership.
Only the exact methods below are allowed for the Gateway by
`gateway-customer-policy.json`; the internal 34-RPC allowlist remains separate.

| HTTP route | Owner | Facade RPC |
|---|---|---|
| `POST /v1/auth/driver-registration/otp` | Identity | `IdentityDriverRegistrationFacadeService/RequestDriverOtp` |
| `POST /v1/auth/driver-registration/otp/verify` | Identity | `IdentityDriverRegistrationFacadeService/VerifyDriverOtp` |
| `POST /v1/driver-applications` | Identity coordinator | `IdentityDriverRegistrationFacadeService/SubmitDriverApplication` |
| `GET /v1/driver-registration-operations/{operationId}` | Identity | `IdentityDriverRegistrationFacadeService/GetDriverRegistrationOperation` |
| `GET /v1/driver-applications/me` | Driver | `DriverApplicationFacadeService/GetMyDriverApplication` |
| `GET /v1/operations/driver-applications` | Driver | `DriverApplicationFacadeService/ListDriverApplications` |
| `GET /v1/operations/driver-applications/{applicationId}` | Driver | `DriverApplicationFacadeService/GetDriverApplication` |
| `POST /v1/operations/driver-applications/{applicationId}/review` | Driver | `DriverApplicationFacadeService/ReviewDriverApplication` |

Identity binds each one-use verification proof to the same canonical Vietnamese phone
(`+84` plus the last nine digits) used by Account lookup; public requests and responses
use `^0[0-9]{9}$`. Existing `+84` challenges and application snapshots remain readable.
Stored legacy `+84` values with ten digits after the country code are returned
unchanged as a temporary read exception; no digit is cut and new phone requests
still require the domestic format.
The proof retains its `DRIVER_REGISTRATION` purpose. OTP is random, expires after five minutes, and
has five attempts; resend is limited to one minute per phone. The dev-only OTP
reader requires local ignored keys and is not a network endpoint. With both
`NODE_ENV=development` and `CAB_DEMO_OTP_RESPONSE_ENABLED=1` on Identity and
Gateway, the 202 `DriverOtpChallenge` carries optional `otp` (field 7), the
six-digit code of that exact `challengeId`. Gateway validates presence/format
and exposes it only under the same gate. Disabled or production responses omit
the field. The code remains transient in the response; the existing DB stores
only its keyed digest and encrypted delivery payload, never plaintext.
Responses use `Cache-Control: no-store`; logs, outbox and receipts omit the code.
Submission
accepts an optional legacy Idempotency-Key; otherwise Gateway generates an
internal key. Identity/Driver IDs remain stable within the durable operation.
A 201 response means
the Driver profile/application is committed; 202 means a durable PROCESSING
operation and `Location`/`Retry-After` for lookup using operation ID and
verification proof. A supplied legacy key is checked when present. Repeating
POST without the legacy key after proof consumption returns
`VERIFICATION_TOKEN_USED`, not a new account or a replay promise. A timeout is
not interpreted as rollback. The pending
Driver may log in, read only its own profile/application and update GPS, but
cannot become AVAILABLE. Review requires OPERATOR and the expected application
and Driver versions; Gateway supplies the separate internal command key when
the client omits the optional legacy header. A committed approval leaves
the Driver OFFLINE; a rejection records reviewer, time and reason. DRIVER and
CUSTOMER cannot use OPERATOR methods. Replay with the same internal command
key returns its receipt; a new key against an already reviewed application
receives 409. A keyless public retry is a new command, so clients must inspect
the current application state after an uncertain response.

Application snapshots and review receipts are encrypted in Driver storage;
outbox/audit stores safe identifiers, not raw password, OTP, JWT or proof.
Registration and review events are recorded locally, but notification delivery
through RabbitMQ is not implemented. This demo review accepts the new vehicle
submitted with the application; the API07 branch selecting an existing vehicle
by `vehicleId`/`expectedVehicleVersion` remains unsupported. Production SMS,
distributed rate limiting, key rotation, and full compensation after partial
provisioning are separate work.
