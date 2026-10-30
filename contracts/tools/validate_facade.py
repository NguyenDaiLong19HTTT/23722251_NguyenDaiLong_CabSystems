"""Static Gateway contract checks against API01 and compiled descriptors.

Synthetic DTOs are contract witnesses, not backend implementations or integration tests.
Run via validate.py; no generated files in the repository.
"""
import copy
import json
from pathlib import Path

import jsonschema
import yaml
from google.protobuf import descriptor_pool, json_format, message_factory

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "contracts"
PACKAGE = "cab.gateway.v1"
PREFIX = "/" + PACKAGE + "."
EXPECTED = {
    "IdentityFacadeService": {
        "RegisterCustomer": ("RegisterCustomerRequest", "RegisterCustomerResponse"),
        "GetCustomerRegistration": ("GetCustomerRegistrationRequest", "CustomerRegistrationOperation"),
        "Login": ("LoginRequest", "AuthSession"),
        "GetMyAccount": ("GetMyAccountRequest", "Account"),
    },
    "CustomerFacadeService": {"GetCustomer": ("GetCustomerRequest", "Account")},
    "DriverFacadeService": {
        "GetMyDriverProfile": ("GetMyDriverProfileRequest", "DriverProfile"),
        "GetDriverById": ("GetDriverByIdRequest", "DriverPublicProfile"),
        "SetMyDriverAvailability": ("SetMyDriverAvailabilityRequest", "Driver"),
        "UpdateMyDriverLocation": ("UpdateMyDriverLocationRequest", "LocationUpdateResult"),
        "SearchNearbyDrivers": ("SearchNearbyDriversRequest", "NearbyDriverPage"),
    },
    "IdentityDriverRegistrationFacadeService": {
        "RequestDriverOtp": ("RequestDriverOtpRequest", "DriverOtpChallenge"),
        "VerifyDriverOtp": ("VerifyDriverOtpRequest", "DriverPhoneVerification"),
        "SubmitDriverApplication": ("SubmitDriverApplicationRequest", "SubmitDriverApplicationResponse"),
        "GetDriverRegistrationOperation": ("GetDriverRegistrationOperationRequest", "DriverRegistrationOperation"),
    },
    "DriverApplicationFacadeService": {
        "GetMyDriverApplication": ("GetMyDriverApplicationRequest", "DriverApplication"),
        "ListDriverApplications": ("ListDriverApplicationsRequest", "DriverApplicationPage"),
        "GetDriverApplication": ("GetDriverApplicationRequest", "DriverApplication"),
        "ReviewDriverApplication": ("ReviewDriverApplicationRequest", "DriverApplicationReview"),
    },
    "NotificationFacadeService": {
        "ListMyNotifications": ("ListMyNotificationsRequest", "NotificationPage"),
        "MarkMyNotificationRead": ("MarkMyNotificationReadRequest", "NotificationItem"),
    },
    "PaymentFacadeService": {
        "GetTripFare": ("PaymentTripId", "FixedFare"),
        "CreateTripPayment": ("CreateTripPaymentRequest", "PaymentRecord"),
        "GetTripPayment": ("PaymentTripId", "PaymentRecord"),
        "GetPayment": ("PaymentId", "PaymentRecord"),
        "ListPaymentAttempts": ("ListPaymentAttemptsRequest", "PaymentAttemptsPage"),
        "ConfirmCash": ("ConfirmCashRequest", "PaymentRecord"),
        "RetryPayment": ("RetryPaymentRequest", "PaymentRecord"),
        "SimulateDemoTransfer": ("DemoTransferResultRequest", "PaymentRecord"),
    },
    "TripFacadeService": {
        "GetTrip": ("TripIdRequest", "TripView"),
        "GetTripTracking": ("TripIdRequest", "TripTrackingView"),
        "ListMyTrips": ("ListMyTripsRequest", "TripPage"),
        "UpdateTripStatus": ("UpdateTripStatusRequest", "TripView"),
        "CancelTrip": ("CancelTripRequest", "TripView"),
        "ReportTripIncident": ("ReportTripIncidentRequest", "TripIncidentResult"),
        "GetTripClosure": ("TripIdRequest", "TripClosureView"),
        "ResolveTripError": ("ResolveTripErrorRequest", "ResolveTripErrorResult"),
    },
    "BookingFacadeService": {
        "CreateBooking": ("CreateBookingRequest", "BookingMutation"),
        "GetBookingOperation": ("BookingOperationId", "BookingOperation"),
        "ListMyBookings": ("ListMyBookingsRequest", "BookingPage"),
        "GetBooking": ("BookingId", "BookingView"),
        "GetBookingStatus": ("BookingId", "BookingStatusView"),
        "CancelBooking": ("CancelBookingRequest", "BookingMutation"),
        "GetDispatchStatus": ("BookingId", "DispatchStatusView"),
        "ListMyPendingTripRequests": ("ListMyTripRequestsRequest", "TripRequestPage"),
        "GetMyTripRequest": ("TripRequestId", "TripRequestView"),
        "AcceptTripRequest": ("TripRequestId", "TripRequestMutation"),
        "RejectTripRequest": ("RejectTripRequestRequest", "TripRequestView"),
        "GetMyAssignmentOperation": ("BookingOperationId", "AssignmentOperationView"),
    },
    "RatingFacadeService": {
        "CreateTripRating": ("CreateTripRatingRequest", "RatingView"),
        "GetTripRating": ("RatingTripRequest", "RatingView"),
        "ListMyDriverRatings": ("RatingPageRequest", "RatingPage"),
        "ListOperationalRatings": ("RatingPageRequest", "RatingPage"),
    },
}


def check_policy(policy, methods):
    if policy.get("default") != "deny" or set(policy["methods"]) != methods:
        raise ValueError("facade policy coverage/default drift")
    if policy.get("package") != PACKAGE:
        raise ValueError("facade namespace drift")
    if policy.get("identityPrefix") != "spiffe://cab.local/service/":
        raise ValueError("facade identity drift")
    for method, entry in policy["methods"].items():
        owner = ("rating-service" if "RatingFacadeService" in method else
                 "booking-service" if "BookingFacadeService" in method else
                 "trip-service" if "TripFacadeService" in method else
                 "payment-service" if "PaymentFacadeService" in method else
                 "notification-service" if "NotificationFacadeService" in method else
                 "customer-service" if "CustomerFacadeService" in method else
                 "driver-service" if any(x in method for x in
                   ("DriverFacadeService", "DriverApplicationFacadeService")) else "identity-service")
        short = method.rsplit("/", 1)[1]
        user = "required" if short in {"GetMyAccount", "GetCustomer",
             "GetMyDriverProfile", "GetDriverById", "SetMyDriverAvailability", "UpdateMyDriverLocation", "SearchNearbyDrivers",
             "GetMyDriverApplication", "ListDriverApplications", "GetDriverApplication",
             "ReviewDriverApplication", "ListMyNotifications", "MarkMyNotificationRead"} else "none"
        if "PaymentFacadeService" in method: user = "required"
        if "TripFacadeService" in method: user = "required"
        if "BookingFacadeService" in method: user = "required"
        if "RatingFacadeService" in method: user = "required"
        recovery = "required" if short in {"RegisterCustomer", "GetCustomerRegistration"} else "none"
        key = "required" if short == "RegisterCustomer" else "none"
        mutation = short in {"RegisterCustomer", "Login", "SetMyDriverAvailability", "UpdateMyDriverLocation", "MarkMyNotificationRead",
            "RequestDriverOtp", "VerifyDriverOtp", "SubmitDriverApplication", "ReviewDriverApplication",
            "CreateTripPayment", "ConfirmCash", "RetryPayment", "SimulateDemoTransfer",
            "UpdateTripStatus", "CancelTrip", "ReportTripIncident", "ResolveTripError", "CreateBooking", "CancelBooking",
            "AcceptTripRequest", "RejectTripRequest", "CreateTripRating"}
        retry = "no-automatic-mutation-retry" if mutation else "read-unavailable-within-budget"
        if (entry["callers"] != ["api-gateway"] or entry["ownerService"] != owner
                or entry["userContext"] != user or entry.get("registrationRecovery", "none") != recovery
                or entry.get("registrationIdempotency", "none") != key or entry["retry"] != retry
                or not entry["scope"].startswith("facade:")
                or not 0 < entry["deadlineMs"] <= 4000
                or entry.get("idempotencyKey") != ("required" if short in
                    {"SetMyDriverAvailability", "ReviewDriverApplication", "CreateTripPayment",
                     "ConfirmCash", "RetryPayment", "SimulateDemoTransfer"} else None)):
            raise ValueError("unsafe facade policy: " + method)


def validate_facade(desc):
    checks = 0

    def require(condition, reason):
        nonlocal checks
        if not condition:
            raise AssertionError(reason)
        checks += 1

    def rejects(fn, reason):
        nonlocal checks
        try:
            fn()
        except (ValueError, jsonschema.ValidationError, json_format.ParseError):
            checks += 1
        else:
            raise AssertionError("accepted invalid witness: " + reason)

    files = [f for f in desc.file if f.package == PACKAGE]
    methods = {"/" + f.package + "." + s.name + "/" + m.name
               for f in files for s in f.service for m in s.method}
    signatures = {s.name: {m.name: (m.input_type.rsplit(".", 1)[1],
                                     m.output_type.rsplit(".", 1)[1]) for m in s.method}
                  for f in files for s in f.service}
    require(signatures == EXPECTED and len(methods) == 52, "exact fifty-two facade signatures")
    policy = json.loads((BASE / "gateway-customer-policy.json").read_text(encoding="utf-8"))
    check_policy(policy, methods)
    checks += 1
    booking_routes = {
        ("/bookings", "post", "createBooking", "CreateBooking", "booking-service"),
        ("/bookings", "get", "listMyBookings", "ListMyBookings", "booking-service"),
        ("/bookings/{bookingId}", "get", "getBooking", "GetBooking", "booking-service"),
        ("/bookings/{bookingId}/status", "get", "getBookingStatus", "GetBookingStatus", "booking-service"),
        ("/bookings/{bookingId}/cancel", "post", "cancelBooking", "CancelBooking", "booking-service"),
        ("/booking-operations/{operationId}", "get", "getBookingOperation", "GetBookingOperation", "booking-service"),
        ("/bookings/{bookingId}/dispatch/status", "get", "getDispatchStatus", "GetDispatchStatus", "booking-service"),
        ("/drivers/me/trip-requests", "get", "listMyPendingTripRequests", "ListMyPendingTripRequests", "booking-service"),
        ("/trip-requests/{tripRequestId}", "get", "getMyTripRequest", "GetMyTripRequest", "booking-service"),
        ("/trip-requests/{tripRequestId}/accept", "post", "acceptTripRequest", "AcceptTripRequest", "booking-service"),
        ("/trip-requests/{tripRequestId}/reject", "post", "rejectTripRequest", "RejectTripRequest", "booking-service"),
        ("/dispatch-operations/{operationId}", "get", "getMyAssignmentOperation", "GetMyAssignmentOperation", "booking-service"),
    }
    for path, verb, operation_id, rpc, owner in booking_routes:
        api = yaml.safe_load((ROOT / "API-Document" /
            ("02-booking-api.yaml" if rpc in {"CreateBooking", "ListMyBookings", "GetBooking",
              "GetBookingStatus", "CancelBooking", "GetBookingOperation"}
              else "03-dispatch driver-api.yaml")).read_text(encoding="utf-8"))
        entry = api["paths"][path][verb]
        require(entry["operationId"] == operation_id and entry["x-owner-service"] == owner
                and PREFIX + "BookingFacadeService/" + rpc in methods,
                "Booking route/RPC ownership drift: " + rpc)
    trip_api = yaml.safe_load((ROOT / "API-Document/04-trip-api.yaml").read_text(encoding="utf-8"))
    for path, verb, operation_id, rpc in (
        ("/trips/{tripId}/tracking", "get", "getTripTracking", "GetTripTracking"),
        ("/trips/{tripId}/incidents", "post", "reportTripIncident", "ReportTripIncident"),
    ):
        entry = trip_api["paths"][path][verb]
        require(entry["operationId"] == operation_id and entry["x-owner-service"] == "trip-service"
                and PREFIX + "TripFacadeService/" + rpc in methods,
                "Trip route/RPC ownership drift: " + rpc)
    operations = yaml.safe_load((ROOT / "API-Document/07-operations-api.yaml").read_text(encoding="utf-8"))
    resolution = operations["paths"]["/operations/trips/{tripId}/resolve-error"]["post"]
    require(resolution["operationId"] == "resolveTripError" and
            resolution["x-owner-service"] == "trip-service" and
            PREFIX + "TripFacadeService/ResolveTripError" in methods,
            "Trip resolution route/RPC ownership drift")
    rating_api = yaml.safe_load((ROOT / "API-Document/08-rating-api.yaml").read_text(encoding="utf-8"))
    for path, verb, operation_id, rpc in (
        ("/trips/{tripId}/rating", "post", "createTripRating", "CreateTripRating"),
        ("/trips/{tripId}/rating", "get", "getTripRating", "GetTripRating"),
        ("/drivers/me/ratings", "get", "listMyDriverRatings", "ListMyDriverRatings"),
        ("/operations/ratings", "get", "listOperationalRatings", "ListOperationalRatings"),
    ):
        entry = rating_api["paths"][path][verb]
        require(entry["operationId"] == operation_id and entry["x-owner-service"] == "rating-service"
                and PREFIX + "RatingFacadeService/" + rpc in methods,
                "Rating route/RPC ownership drift: " + rpc)
    internal = json.loads((BASE / "rpc-policy.json").read_text(encoding="utf-8"))
    require(len(internal["methods"]) == 41, "internal count must stay 41")
    require(all("api-gateway" not in e["callers"] for e in internal["methods"].values()),
            "Gateway cannot call internal worker RPC")
    require(not (set(internal["methods"]) & methods), "policies must be disjoint")
    for kind in ("missing", "extra", "allow-default", "wrong-caller", "missing-user", "retry-login"):
        bad = copy.deepcopy(policy)
        method = sorted(methods)[0]
        if kind == "missing":
            bad["methods"].pop(method)
        elif kind == "extra":
            bad["methods"]["/cab.internal.v1.CustomerInternalService/ProvisionCustomer"] = bad["methods"][method]
        elif kind == "allow-default":
            bad["default"] = "allow"
        elif kind == "wrong-caller":
            bad["methods"][method]["callers"] = ["booking-service"]
        elif kind == "missing-user":
            bad["methods"][PREFIX + "IdentityFacadeService/GetMyAccount"]["userContext"] = "none"
        else:
            bad["methods"][PREFIX + "IdentityFacadeService/Login"]["retry"] = "read-unavailable-within-budget"
        rejects(lambda: check_policy(bad, methods), kind)

    api = yaml.safe_load((ROOT / "API-Document/01-auth-customer-api.yaml").read_text(encoding="utf-8"))
    mapping = json.loads((BASE / "gateway-customer-mapping.json").read_text(encoding="utf-8"))
    require(mapping["package"] == PACKAGE, "mapping namespace")
    require(mapping["api"] == "API-Document/01-auth-customer-api.yaml", "API01 source")
    endpoints = mapping["endpoints"]
    expected_routes = {
        ("post", "/auth/register"), ("get", "/auth/customer-registrations/{operationId}"),
        ("post", "/auth/login"), ("get", "/accounts/me"), ("get", "/customers/{customerId}"),
    }
    require(len(endpoints) == 5 and {(e["verb"], e["path"]) for e in endpoints} == expected_routes,
            "exact five REST routes")
    customer_methods = {m for m in methods if any(x in m for x in
        ("IdentityFacadeService", "CustomerFacadeService"))}
    require({e["rpc"] for e in endpoints} == customer_methods, "Customer route/RPC bijection")
    require(any(s["url"] == "/v1" for s in api["servers"]), "REST prefix unchanged")
    for entry in endpoints:
        op = api["paths"][entry["path"]][entry["verb"]]
        require(entry["operationId"] == op["operationId"], "REST operationId drift")
        require(entry["ownerService"] == op["x-owner-service"] == policy["methods"][entry["rpc"]]["ownerService"],
                "REST owner drift")
        require(entry["restSecurity"] == op.get("security", api["security"]), "REST security drift")
        if entry["requestSchema"]:
            ref = op["requestBody"]["content"]["application/json"]["schema"]["$ref"]
            require(ref == "#/components/schemas/" + entry["requestSchema"], "REST request drift")
        declared = set(op["responses"]) - {"default"}
        require(declared == set(entry["successSchemas"]) | set(entry["errors"]), "endpoint HTTP status drift")
        require("default" in op["responses"], "default error response remains")
        for status, schema in entry["successSchemas"].items():
            ref = op["responses"][status]["content"]["application/json"]["schema"]["$ref"]
            require(ref == "#/components/schemas/" + schema, "REST success schema drift")
        for status, codes in entry["errors"].items():
            require(bool(codes), "empty error mapping")
            response = op["responses"][status]
            if "$ref" in response:
                response = api["components"]["responses"][response["$ref"].rsplit("/", 1)[1]]
            for code, grpc_status in codes.items():
                require(code in str(response),
                        "invented REST error code " + code)
                expected_grpc = {
                    "400": {"INVALID_ARGUMENT"}, "401": {"UNAUTHENTICATED"},
                    "403": {"PERMISSION_DENIED"}, "404": {"NOT_FOUND"},
                    "409": {"ALREADY_EXISTS", "FAILED_PRECONDITION"},
                    "429": {"RESOURCE_EXHAUSTED"}, "503": {"UNAVAILABLE"},
                }
                require(grpc_status in expected_grpc[status], "gRPC/HTTP mapping drift")

    for source, route, verb, operation, response in (
        ("07-operations-api.yaml", "/drivers/me", "get", "getMyDriverProfile", "DriverProfileRead"),
        ("07-operations-api.yaml", "/drivers/{driverId}", "get", "getDriverById", None),
        ("07-operations-api.yaml", "/drivers/me/availability", "put", "setMyDriverAvailability", "DriverRead"),
        ("04-trip-api.yaml", "/drivers/me/location", "put", "updateMyDriverLocation", None),
    ):
        driver_api = yaml.safe_load((ROOT / "API-Document" / source).read_text(encoding="utf-8"))
        op = driver_api["paths"][route][verb]
        require(op["operationId"] == operation and op["x-owner-service"] == "driver-service",
                "Driver route/owner drift: " + route)
        if response:
            require(op["responses"]["200"]["$ref"] == "#/components/responses/" + response,
                    "Driver response drift: " + route)
    new_routes = (
        ("01-auth-customer-api.yaml", "/auth/driver-registration/otp", "post", "requestDriverRegistrationOtp", "identity-service", "RequestDriverOtp"),
        ("01-auth-customer-api.yaml", "/auth/driver-registration/otp/verify", "post", "verifyDriverRegistrationOtp", "identity-service", "VerifyDriverOtp"),
        ("07-operations-api.yaml", "/driver-applications", "post", "submitDriverApplication", "identity-service", "SubmitDriverApplication"),
        ("07-operations-api.yaml", "/driver-registration-operations/{operationId}", "get", "getDriverRegistrationOperation", "identity-service", "GetDriverRegistrationOperation"),
        ("07-operations-api.yaml", "/driver-applications/me", "get", "getMyDriverApplication", "driver-service", "GetMyDriverApplication"),
        ("07-operations-api.yaml", "/operations/driver-applications", "get", "listDriverApplications", "driver-service", "ListDriverApplications"),
        ("07-operations-api.yaml", "/operations/driver-applications/{applicationId}", "get", "getDriverApplication", "driver-service", "GetDriverApplication"),
        ("07-operations-api.yaml", "/operations/driver-applications/{applicationId}/review", "post", "reviewDriverApplication", "driver-service", "ReviewDriverApplication"),
    )
    for source, route, verb, operation_id, owner, method in new_routes:
        document = yaml.safe_load((ROOT / "API-Document" / source).read_text(encoding="utf-8"))
        op = document["paths"][route][verb]
        require(op["operationId"] == operation_id and op["x-owner-service"] == owner,
                "Driver registration route drift: " + route)
        require(sum(path.endswith("/" + method) for path in methods) == 1,
                "Driver registration RPC missing/ambiguous: " + method)

    def http_error(entry, grpc_status, code=None, origin=None):
        # Static specification: never confuse a service-auth/dependency error with user auth.
        if origin == "SERVICE" or grpc_status in {"UNAVAILABLE", "DEADLINE_EXCEEDED", "CANCELLED"}:
            return 503, "SERVICE_UNAVAILABLE"
        if grpc_status in {"UNAUTHENTICATED", "PERMISSION_DENIED"} and origin != "END_USER":
            return 503, "SERVICE_UNAVAILABLE"
        for status, codes in entry["errors"].items():
            if code in codes and codes[code] == grpc_status:
                return int(status), code
        return 503, "SERVICE_UNAVAILABLE"

    for entry in endpoints:
        for status, codes in entry["errors"].items():
            for code, grpc_status in codes.items():
                require(http_error(entry, grpc_status, code, "END_USER") == (int(status), code), "error witness")
        for grpc_status, code, origin in (
            ("UNAUTHENTICATED", "UNAUTHENTICATED", "SERVICE"),
            ("PERMISSION_DENIED", "ACCOUNT_NOT_ACTIVE", "SERVICE"),
            ("UNAUTHENTICATED", "INVALID_CREDENTIALS", None),
            ("DEADLINE_EXCEEDED", None, None), ("CANCELLED", None, None),
            ("INTERNAL", None, None), ("NOT_FOUND", "UNRECOGNIZED", "END_USER"),
            ("RESOURCE_EXHAUSTED", "SERVICE_UNAVAILABLE", None),
        ):
            require(http_error(entry, grpc_status, code, origin) == (503, "SERVICE_UNAVAILABLE"),
                    "fail closed service/dependency/unknown error")

    pool = descriptor_pool.DescriptorPool()
    for f in desc.file:
        pool.Add(f)
    def cls(name):
        return message_factory.GetMessageClass(pool.FindMessageTypeByName(PACKAGE + "." + name))

    notification_fields = {
        "ListMyNotificationsRequest": {"isRead", "limit", "cursor"},
        "MarkMyNotificationReadRequest": {"notificationId"},
        "NotificationItem": {"notificationId", "eventId", "recipientAccountId",
            "eventType", "referenceType", "referenceId", "channel", "deliveryStatus",
            "title", "message", "isRead", "readAt", "occurredAt", "createdAt", "publishedAt"},
        "NotificationPage": {"items", "nextCursor"},
    }
    for name, names in notification_fields.items():
        descriptor = cls(name).DESCRIPTOR
        require({field.json_name for field in descriptor.fields} == names,
                "Notification DTO drift: " + name)
        require(all(field.has_presence for field in descriptor.fields if not field.is_repeated),
                "Notification DTO missing presence: " + name)
    item_descriptor = cls("NotificationItem").DESCRIPTOR
    for name in ("read_at", "occurred_at", "created_at", "published_at"):
        require(item_descriptor.fields_by_name[name].message_type.full_name ==
                "google.protobuf.Timestamp", "Notification timestamp drift: " + name)
    missing = cls("NotificationItem")()
    require(not missing.HasField("is_read") and not missing.HasField("published_at"),
            "Notification response absence must be observable")

    # CustomerProfile uses the Identity-owned Account metadata, not local Customer times.
    contact = pool.FindMessageTypeByName("cab.internal.v1.AccountContact")
    require({f.number: f.name for f in contact.fields} == {
        1: "account_id", 2: "full_name", 3: "email", 4: "phone",
        5: "account_version", 6: "verified_at", 7: "account_status",
        8: "created_at", 9: "updated_at"}, "AccountContact field numbers drift")
    status_field = contact.fields_by_name["account_status"]
    require(status_field.has_presence and status_field.type == status_field.TYPE_ENUM
            and status_field.enum_type.full_name == "cab.internal.v1.AccountContact.AccountStatus",
            "AccountContact status type/presence")
    for name in ("created_at", "updated_at"):
        field = contact.fields_by_name[name]
        require(field.has_presence and field.message_type.full_name == "google.protobuf.Timestamp",
                "AccountContact timestamp type/presence: " + name)
    statuses = status_field.enum_type.values
    require(statuses[0].name == "ACCOUNT_STATUS_UNSPECIFIED" and statuses[0].number == 0
            and {value.name for value in statuses[1:]} ==
            set(api["components"]["schemas"]["Account"]["properties"]["accountStatus"]["enum"]),
            "AccountContact status values drift from API01")
    contact_cls = message_factory.GetMessageClass(contact)
    witness = json_format.ParseDict({"accountId": "ACC_contract", "fullName": "Contract",
        "accountStatus": "INACTIVE", "createdAt": "2026-10-01T00:00:00Z",
        "updatedAt": "2026-10-02T00:00:00Z"}, contact_cls())
    decoded = contact_cls.FromString(witness.SerializeToString())
    require(all(decoded.HasField(name) for name in ("account_status", "created_at", "updated_at"))
            and decoded.account_status == status_field.enum_type.values_by_name["INACTIVE"].number,
            "AccountContact fixture lost required fields")
    decoded.ClearField("updated_at")
    require(not decoded.HasField("updated_at"), "AccountContact missing timestamp hidden by default")

    # API07/API04 Driver facade: exact DTO fields and scalar/message presence.
    driver_fields = {
        "GetMyDriverProfileRequest": set(),
        "GetDriverByIdRequest": {"driverId"},
        "DriverPublicProfile": {"driverId", "fullName"},
        "Driver": {"driverId", "accountId", "licenseNumber", "approvalStatus",
                   "driverStatus", "vehicleId", "version", "createdAt", "updatedAt", "rejectionReason"},
        "Vehicle": {"vehicleId", "plateNumber", "vehicleType", "vehicleStatus",
                    "assignedDriverId", "version", "createdAt", "updatedAt"},
        "DriverProfile": {"driver", "vehicle"},
        "SetMyDriverAvailabilityRequest": {"expectedVersion", "driverStatus"},
        "UpdateMyDriverLocationRequest": {"latitude", "longitude", "recordedAt"},
        "DriverLocation": {"latitude", "longitude", "recordedAt", "receivedAt"},
        "LocationUpdateResult": {"locationUpdated", "currentLocation"},
    }
    for name, expected_names in driver_fields.items():
        d = pool.FindMessageTypeByName(PACKAGE + "." + name)
        require({f.json_name for f in d.fields} == expected_names,
                "Driver DTO fields drift: " + name)
        for f in d.fields:
            require(f.has_presence, "Driver DTO presence missing: " + name + "." + f.name)
    payment_fields = {
        "PaymentTripId": {"tripId"}, "PaymentId": {"paymentId"},
        "ListPaymentAttemptsRequest": {"paymentId", "limit", "cursor"},
        "CreateTripPaymentRequest": {"tripId", "paymentMethod"},
        "ConfirmCashRequest": {"paymentId", "expectedVersion"},
        "RetryPaymentRequest": {"paymentId", "expectedVersion", "paymentMethod"},
        "DemoTransferResultRequest": {"paymentId", "attemptId", "expectedVersion", "expectedAmount", "currency", "outcome"},
        "FixedFare": {"fareId", "tripId", "pricingVersionId", "routeId", "routeVersion",
                      "distanceMeters", "totalAmount", "currency", "calculatedAt"},
        "PaymentRecord": {"paymentId", "tripId", "fareId", "customerId", "amount", "currency",
                          "method", "paymentStatus", "currentAttemptId", "requiresReview", "version",
                          "createdAt", "updatedAt", "paidAt", "confirmedByAccountId"},
        "PaymentAttemptRecord": {"attemptId", "paymentId", "attemptNumber", "method",
                                 "amount", "currency", "status", "merchantReference",
                                 "resolvedAt", "createdAt", "updatedAt", "confirmedByAccountId"},
        "PaymentAttemptsPage": {"items", "nextCursor"},
    }
    for name, expected_names in payment_fields.items():
        d = pool.FindMessageTypeByName(PACKAGE + "." + name)
        require({f.json_name for f in d.fields} == expected_names,
                "Payment DTO fields drift: " + name)
        for f in d.fields:
            if f.name != "items":
                require(f.has_presence, "Payment DTO presence missing: " + name + "." + f.name)
    application_fields = {
        "RequestDriverOtpRequest": {"phone"},
        "VerifyDriverOtpRequest": {"challengeId", "otp"},
        "DriverOtpChallenge": {"challengeId", "purpose", "status", "createdAt", "expiresAt", "resendAvailableAt", "otp"},
        "DriverPhoneVerification": {"verificationToken", "purpose", "verifiedPhone", "verifiedAt", "expiresAt"},
        "SubmitDriverApplicationRequest": {"verificationToken", "fullName", "email", "password", "licenseNumber", "vehicle"},
        "DriverRegistrationResult": {"accountId", "driverId", "applicationId", "accountStatus", "approvalStatus", "driverStatus", "applicationStatus", "submittedAt"},
        "GetDriverRegistrationOperationRequest": {"operationId"},
        "GetMyDriverApplicationRequest": set(),
        "ListDriverApplicationsRequest": {"status", "limit", "cursor"},
        "GetDriverApplicationRequest": {"applicationId"},
        "ReviewDriverApplicationRequest": {"applicationId", "expectedVersion", "expectedDriverVersion", "decision", "rejectionReason", "vehicleId", "expectedVehicleVersion"},
    }
    for name, names in application_fields.items():
        descriptor = pool.FindMessageTypeByName(PACKAGE + "." + name)
        require({field.json_name for field in descriptor.fields} == names,
                "Driver application DTO drift: " + name)
        require(all(field.has_presence for field in descriptor.fields),
                "Driver application DTO missing presence: " + name)
    otp_descriptor = pool.FindMessageTypeByName(PACKAGE + ".DriverOtpChallenge")
    otp_field = otp_descriptor.fields_by_name["otp"]
    require(otp_field.number == 7 and otp_field.type == otp_field.TYPE_STRING
            and otp_field.has_presence, "demo OTP field number/type/presence")
    otp_schema = api["components"]["schemas"]["DriverOtpChallengeResponse"]
    require("otp" in otp_schema["properties"] and "otp" not in otp_schema["required"],
            "demo OTP must be optional in REST")
    otp_validator = jsonschema.Draft4Validator(otp_schema, format_checker=jsonschema.FormatChecker())
    otp_base = {"challengeId": "CH_contract", "purpose": "DRIVER_REGISTRATION",
                "status": "ACCEPTED", "createdAt": "2026-10-01T00:00:00Z",
                "expiresAt": "2026-10-01T00:05:00Z",
                "resendAvailableAt": "2026-10-01T00:01:00Z"}
    otp_validator.validate(otp_base)
    otp_validator.validate(dict(otp_base, otp="012345"))
    rejects(lambda: otp_validator.validate(dict(otp_base, otp="12345")),
            "demo OTP must contain exactly six digits")
    driver_api = yaml.safe_load((ROOT / "API-Document/07-operations-api.yaml").read_text(encoding="utf-8"))
    for name, schema in (("DriverApprovalStatus", "DriverApprovalStatus"),
                         ("DriverStatus", "DriverStatus"), ("VehicleType", "VehicleType")):
        values = pool.FindEnumTypeByName(PACKAGE + "." + name).values
        require(values[0].number == 0 and {v.name for v in values[1:]} ==
                set(driver_api["components"]["schemas"][schema]["enum"]),
                "Driver enum drift: " + name)

    # Descriptor shape/presence guards: no string/number default can mask a missing field.
    fields = {
        "RegisterCustomerRequest": {"fullName", "email", "phone", "password"},
        "LoginRequest": {"emailOrPhone", "password"},
        "GetCustomerRegistrationRequest": {"operationId"},
        "GetMyAccountRequest": set(), "GetCustomerRequest": {"customerId"},
        "Account": set(api["components"]["schemas"]["Account"]["properties"]),
        "AuthSession": set(api["components"]["schemas"]["AuthSessionResponse"]["properties"]),
        "CustomerRegistrationOperation": set(api["components"]["schemas"]["CustomerRegistrationOperation"]["properties"]),
        "ErrorResponse": set(api["components"]["schemas"]["ErrorResponse"]["properties"]),
        "FieldError": set(api["components"]["schemas"]["FieldError"]["properties"]),
    }
    for name, names in fields.items():
        d = cls(name).DESCRIPTOR
        require({f.json_name for f in d.fields} == names, "DTO fields drift: " + name)
        for f in d.fields:
            require(f.has_presence, "presence missing: " + name + "." + f.name)
            require(f.type not in {f.TYPE_DOUBLE, f.TYPE_FLOAT, f.TYPE_BYTES}, "untyped field")
            if f.message_type:
                require(f.message_type.full_name not in {"google.protobuf.Any", "google.protobuf.Struct"}, "JSON blob")
    for name, target in (("Role", api["components"]["schemas"]["Account"]["properties"]["role"]["enum"]),
                         ("AccountStatus", api["components"]["schemas"]["Account"]["properties"]["accountStatus"]["enum"]),
                         ("RegistrationStatus", api["components"]["schemas"]["CustomerRegistrationOperation"]["properties"]["status"]["enum"])):
        values = pool.FindEnumTypeByName(PACKAGE + "." + name).values
        require(values[0].number == 0 and {v.name for v in values[1:]} == set(target), "enum drift " + name)
    require({f.name for f in cls("Account").DESCRIPTOR.oneofs_by_name["profile"].fields}
            == {"customer_id", "driver_id", "operator_id"}, "profile union")
    require({f.name for f in cls("RegisterCustomerResponse").DESCRIPTOR.oneofs_by_name["outcome"].fields}
            == {"created", "processing"}, "register union")

    def schema_check(schema, value):
        root = {"$ref": "#/components/schemas/" + schema, "components": api["components"]}
        jsonschema.Draft4Validator(root, format_checker=jsonschema.FormatChecker()).validate(value)

    def project(message):
        # Executable specification of the transport-to-REST shape, not a production handler.
        value = json_format.MessageToDict(message)
        def flatten(obj):
            if not isinstance(obj, dict):
                return
            if "details" in obj:
                obj["details"] = obj["details"].get("items", [])
            if obj.get("tokenType") == "BEARER":
                obj["tokenType"] = "Bearer"
            for child in obj.values():
                if isinstance(child, dict):
                    flatten(child)
        flatten(value)
        return value

    def dto(name, wire, schema):
        nonlocal checks
        msg = json_format.ParseDict(wire, cls(name)())
        restored = cls(name).FromString(msg.SerializeToString())
        result = project(restored)
        schema_check(schema, result)
        if name == "AuthSession" and result["account"]["accountStatus"] != "ACTIVE":
            raise ValueError("login cannot issue a session for an inactive account")
        checks += 1
        return result

    now = "2026-10-01T00:00:00Z"
    account = {"accountId": "ACC_contract", "fullName": "Contract Customer", "email": "contract@example.com",
               "phone": "0901234567", "role": "CUSTOMER", "accountStatus": "ACTIVE",
               "customerId": "CUS_contract", "createdAt": now, "updatedAt": now}
    registration = {"operationId": "REG_contract", "status": "PROCESSING", "createdAt": now, "updatedAt": now}
    synthetic_error = {"errorCode": "REGISTRATION_FAILED", "message": "Synthetic terminal failure"}
    dto("Account", account, "RegisteredCustomerAccount")
    dto("Account", account, "CustomerProfile")
    for role, key in (("CUSTOMER", "customerId"), ("DRIVER", "driverId"), ("OPERATOR", "operatorId")):
        a = {k: v for k, v in account.items() if k != "customerId"}
        a.update(role=role, **{key: "PROFILE_contract"})
        dto("Account", a, "Account")
        dto("AuthSession", {"accessToken": "synthetic-access-not-a-jwt", "refreshToken": "synthetic-refresh",
                            "tokenType": "BEARER", "expiresIn": 900, "sessionExpiresAt": now, "account": a},
            "AuthSessionResponse")
    for status in ("PROCESSING", "SUCCEEDED", "FAILED"):
        op = dict(registration, status=status)
        if status == "SUCCEEDED":
            op["result"] = account
        elif status == "FAILED":
            op["error"] = synthetic_error
        dto("CustomerRegistrationOperation", op, "CustomerRegistrationOperation")
    for status in ("INACTIVE", "SUSPENDED"):
        dto("Account", dict(account, accountStatus=status), "CustomerProfile")
    for error in (synthetic_error, dict(synthetic_error, details={}),
                  dict(synthetic_error, details={"items": [{"field": "phone", "message": "Synthetic"}]}),
                  dict(synthetic_error, correlationId="")):
        dto("ErrorResponse", error, "ErrorResponse")

    register_input = {"fullName": "Contract Customer", "email": "contract@example.com", "phone": "0901234567",
                      "password": "synthetic-password-only"}
    dto("RegisterCustomerRequest", register_input, "RegisterRequest")
    dto("LoginRequest", {"emailOrPhone": "contract@example.com", "password": "synthetic-only"}, "LoginRequest")
    for field in register_input:
        bad = dict(register_input)
        bad.pop(field)
        rejects(lambda: dto("RegisterCustomerRequest", bad, "RegisterRequest"), "missing " + field)
    for field, value in (("fullName", "   "), ("email", "invalid"), ("phone", "090123456"),
                         ("password", "short"), ("password", "        ")):
        bad = dict(register_input, **{field: value})
        rejects(lambda: dto("RegisterCustomerRequest", bad, "RegisterRequest"), "invalid " + field)
    rejects(lambda: dto("RegisterCustomerRequest", dict(register_input, role="OPERATOR"), "RegisterRequest"), "role injection")
    rejects(lambda: schema_check("RegisterRequest", dict(register_input, password=None)), "null REST password")
    for field in ("accountId", "role", "createdAt"):
        bad = dict(account)
        bad.pop(field)
        rejects(lambda: dto("Account", bad, "Account"), "missing account " + field)
    for changes in ({"role": "DRIVER"}, {"role": "ROLE_UNSPECIFIED"}, {"role": 999},
                    {"accountStatus": "ACCOUNT_STATUS_UNSPECIFIED"}, {"customerId": ""},
                    {"updatedAt": "invalid-timestamp"}):
        rejects(lambda: dto("Account", dict(account, **changes), "Account"), "invalid account")
    rejects(lambda: dto("Account", dict(account, driverId="DRV_contract"), "Account"), "two profile branches")
    rejects(lambda: dto("Account", dict(account, accountStatus="INACTIVE"), "RegisteredCustomerAccount"), "inactive201")
    rejects(lambda: dto("CustomerRegistrationOperation", dict(registration, result=account), "CustomerRegistrationOperation"), "processing with result")
    rejects(lambda: dto("CustomerRegistrationOperation", dict(registration, status="SUCCEEDED"), "CustomerRegistrationOperation"), "success without result")
    rejects(lambda: dto("CustomerRegistrationOperation", dict(registration, status="FAILED"), "CustomerRegistrationOperation"), "failed without error")
    for op_id in ("", "X" * 129):
        rejects(lambda: dto("CustomerRegistrationOperation", dict(registration, operationId=op_id), "CustomerRegistrationOperation"), "operation bounds")
    for expiry in (0, 901):
        session = {"accessToken": "synthetic", "refreshToken": "synthetic", "tokenType": "BEARER",
                   "expiresIn": expiry, "sessionExpiresAt": now, "account": account}
        rejects(lambda: dto("AuthSession", session, "AuthSessionResponse"), "expiresIn bounds")

    def register_response(wire):
        msg = json_format.ParseDict(wire, cls("RegisterCustomerResponse")())
        outcome = msg.WhichOneof("outcome")
        if outcome == "created":
            schema_check("RegisteredCustomerAccount", project(msg.created))
            return 201
        if outcome != "processing" or not msg.processing.HasField("operation"):
            raise ValueError("missing durable operation witness")
        p = msg.processing
        if not p.HasField("retry_after_seconds") or p.retry_after_seconds < 1:
            raise ValueError("missing Retry-After")
        value = project(p.operation)
        schema_check("CustomerRegistrationOperation", value)
        if value["status"] != "PROCESSING":
            raise ValueError("202 must be PROCESSING")
        return 202
    require(register_response({"created": account}) == 201, "201 branch")
    require(register_response({"processing": {"operation": registration, "retryAfterSeconds": 1}}) == 202, "202 branch")
    for wire in ({}, {"processing": {}}, {"processing": {"operation": registration}},
                 {"processing": {"operation": registration, "retryAfterSeconds": 0}},
                 {"processing": {"operation": dict(registration, status="SUCCEEDED", result=account), "retryAfterSeconds": 1}}):
        rejects(lambda: register_response(wire), "invalid201/202 witness")

    # Check REST header constraints directly from API01, without storing any real secret.
    headers = api["components"]["parameters"]
    for name, good, bad in (("RegistrationIdempotencyKey", "00000000-0000-4000-8000-000000000001", "not-uuid"),
                            ("RegistrationRecoveryToken", "A" * 43, "A" * 42)):
        validator = jsonschema.Draft4Validator(headers[name]["schema"], format_checker=jsonschema.FormatChecker())
        validator.validate(good)
        checks += 1
        rejects(lambda: validator.validate(bad), "invalid header " + name)
    print(f"PASS facade static: 52 RPCs/policy; 5 API01 + 5 Driver + 8 Driver registration/review + 2 Notification + 8 Payment + 8 Trip + 12 Booking/Dispatch + 4 Rating routes, typed presence/enums and DTO wire/schema witnesses; {checks} checks (including negative witnesses).")
    return checks
