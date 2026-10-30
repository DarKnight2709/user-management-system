# Authorization security event

## `authorization.denied`

Records an authenticated request rejected by `PermissionsGuard` after the
permission service returns `false`.

- `actor`: authenticated user UUID.
- `scope`: `PLATFORM` or `ORGANIZATION`.
- `requiredPermissions`: bounded resource/action pairs from the permission
  catalog.
- `organizationId`: included only for organization-scoped checks.
- `reasonCode`: distinguishes a missing platform permission from an
  organization permission or membership denial. The organization check does
  not reveal which of those two conditions failed.
- `requestContext`: server request ID and validated optional IP/User-Agent.
- Category: `security`; outcome: `FAILURE`; level: `warn`.

The event is emitted immediately before the guard returns 403. Logging is
best-effort and does not alter the authorization response.

It is not emitted for missing or invalid authentication, invalid route IDs,
empty/malformed permission metadata, or database failures. Those have separate
request/error handling. The event contains no request body, headers, token,
resource target data, or free-form error text.

The ordinary HTTP request summary remains separate: it records route and final
status, while this security event records the authenticated actor and required
permission scope. Successful role or permission changes belong to audit logging.
