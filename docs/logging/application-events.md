# Application event catalog

## Scope and rollout

`LoggingService.application()` validates operational events with Joi and writes
them through Winston Console -> Docker -> Alloy -> Loki. It does not persist
events to PostgreSQL or wait for Loki acknowledgement.

The catalog defines the two existing Auth operational events below.
AuthService sends both auth.refresh_failed and auth.logout_failed through
LoggingService.application(). Both retain the original thrown operation error.
This is not yet a replacement for all application log producers.

## HTTP request summaries

- LoggerMiddleware emits `http.request.completed` or `http.request.aborted`.
- Fields are method, registered route template (or `[unmatched]`), durationMs,
  statusCode, outcome and the server-generated request ID.
- Completion uses info for 1xx-3xx, warn for 4xx and error for 5xx. An aborted
  request uses warn and a null statusCode.
- A response emits at most one summary across `finish` and `close`. Completion
  only means the backend handed off the response; it does not prove receipt.
- Raw URL, query, headers, body, cookies, tokens and raw errors are excluded.
- Unknown HTTP methods become `OTHER`; unsafe route templates become `[unmatched]`.
- Exception-filter diagnostics remain a separate migration step.

## Input and failure handling

- `event` must be a supported catalog entry. Each event has its own field allowlist.
- `requestContext.requestId` must be a server-controlled UUID.
- The service creates eventId, occurredAt (UTC), environment and schemaVersion.
- Policy owns category, level and fixed message; callers cannot override them.
- Unknown fields, including raw errors, stack, body, tokens and arbitrary metadata,
  are removed before serialization. Required fields must remain valid.
- These schemas do not accept free-text diagnostic fields. Validation is not a
  general-purpose secret detector for arbitrary strings.
- Existing serialization limits each event to 16 KiB. Winston redaction remains
  an additional safeguard after schema validation.
- Validation, serialization and synchronous logger failures use the existing
  safe fallback counter and must not replace the original operation error.
- Asynchronous Winston errors use the existing transport-error listener.

## auth.refresh_failed

- Category: application; level: error; schemaVersion: 1.
- Message: `Refresh token processing failed`.
- Input: event and requestContext.requestId.
- Trigger: unexpected refresh-processing failure, after transaction
  retries are exhausted where applicable. Rejected or expired tokens and token
  reuse are excluded.
- Producer: AuthService.refreshToken catch block, outside transaction retries.
  The original error is rethrown after the best-effort log call.

## auth.logout_failed

- Category: application; level: error; schemaVersion: 1.
- Message: `Logout failed`.
- Input: event, authenticated userId (UUID), scope `all_sessions`, requestContext.requestId.
- Trigger: the existing logout-all revocation operation fails after
  transaction retries. The original error must still propagate.
- Single-family logout failure is not covered by this initial catalog entry.

## Refresh failure example

```ts
this.loggingService.application({
  event: 'auth.refresh_failed',
  requestContext: { requestId },
});
```

No raw exception or authentication material belongs in this payload. Request ID
links the event to the HTTP request and other safe diagnostic logs.
