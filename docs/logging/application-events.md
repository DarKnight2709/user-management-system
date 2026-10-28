# Application event catalog

## Scope and rollout

`LoggingService.application()` validates operational events with Joi and writes
them through Winston Console -> Docker -> Alloy -> Loki. It does not persist
events to PostgreSQL or wait for Loki acknowledgement.

This first step defines the two existing Auth operational events below.
Their AuthService call sites still use Nest Logger; migration is the next step.
This is not yet a replacement for all application log producers.

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
- Intended trigger: unexpected refresh-processing failure, after transaction
  retries are exhausted where applicable. Rejected or expired tokens and token
  reuse are excluded.

## auth.logout_failed

- Category: application; level: error; schemaVersion: 1.
- Message: `Logout failed`.
- Input: event, authenticated userId (UUID), scope `all_sessions`, requestContext.requestId.
- Intended trigger: the existing logout-all revocation operation fails after
  transaction retries. The original error must still propagate.
- Single-family logout failure is not covered by this initial catalog entry.

## Example for the upcoming call-site migration

```ts
this.loggingService.application({
  event: 'auth.refresh_failed',
  requestContext: { requestId },
});
```

No raw exception or authentication material belongs in this payload. Request ID
links the event to the HTTP request and other safe diagnostic logs.
