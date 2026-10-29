# Logging rollout inventory

Inventory date: 2026-10-29. This file tracks code inspection, not production verification.

## Completed Auth scope

- Selected Auth security events use LoggingService.security().
- auth.refresh_failed and logout-all's auth.logout_failed use application().
- Single-family logout infrastructure failures use
  auth.logout_session_failed; invalid token outcomes are excluded.
- These operational events are emitted after transaction failures/retries and
  rethrow the original failure. Raw errors and tokens are excluded from their
  payloads.

## Producer inventory and next steps

| Order | Producer                                            | Current state                                                                                                    | Next work                                                                                                                |
| ----- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1     | common/middlewares/logger.middleware.ts             | Implemented: application events for completed/aborted requests                                                   | Verify in Loki; regression tests cover finish/close, severity, null abort status and safe correlation                    |
| 2     | common/filters/all-exceptions.filter.ts             | Implemented: cataloged safe diagnostics for caused HTTP errors, parser 413 and unexpected errors                 | Verify correlation and safe stack-frame rendering in Loki                                                                |
| 2     | common/filters/prisma-exception.filter.ts           | Implemented: cataloged unhandled known-Prisma-code diagnostics                                                   | Verify correlation in Loki; known HTTP mappings remain log-free here                                                     |
| 3     | core/database/prisma.service.ts                     | Implemented: cataloged driver/query diagnostics through application logging                                      | Verify debug filtering, slow-query grouping and optional HTTP correlation in Loki                                        |
| 4     | modules/users/avatar-cleanup.service.ts             | Implemented: cataloged retry and terminal worker diagnostics                                                     | Verify retry grouping and failure categories in Loki                                                                     |
| 4     | invitations/services/invitation-email.service.ts    | Implemented: cataloged queue and enqueue diagnostics                                                             | Verify acknowledgement uncertainty and queue health events in Loki                                                       |
| 4     | invitations/services/invitation-delivery.service.ts | Implemented: cataloged delivery and failure-recording diagnostics                                                | Verify stage and safe error-code grouping in Loki                                                                        |
| 4     | invitations/workers/email-notification.worker.ts    | Implemented: cataloged worker error, job failure and completion events                                           | Verify attempt counts and interpret completion as job completion only                                                    |
| 5     | main.ts and core/logging/graceful-shutdown.ts       | Implemented: bootstrap and shutdown events use LoggingService.application(); raw Winston remains for final flush | Verify lifecycle events and shutdown ordering in Loki; final flush failures are represented by unsuccessful process exit |
| 6     | Winston boundary / Nest framework logs              | Implemented: uncatalogued Winston records receive application/framework.log labels                               | Verify JSON classification in Loki; records remain outside the Joi application-event schema                              |
| 7     | LoggingService fallback                             | Implemented: direct stderr, category logging_internal                                                            | Retain independent fallback to avoid recursive logger failures                                                           |

No direct logger calls were found in core/storage during this inventory. Check
callers and exception filters before adding storage logs that could duplicate errors.
Direct console writes outside the LoggingService fallback are not normalized by
Winston; none are currently used as application producers in `src/`. `repl.ts`
uses Nest's REPL-specific logger for developer tooling and is not the HTTP
application runtime.

## HTTP ownership decisions

- Middleware owns one request summary, including expected 4xx responses.
- Security events describe selected security actions separately.
- Auth domain failures and filter diagnostics are separate records only when the
  propagated HttpException carries a cause. Correlate them by request ID rather
  than suppressing process-wide events.
- Do not suppress unrelated exceptions or use a process-wide flag. Any eventual
  deduplication must be scoped to the exact error/request and preserve diagnostics.
- Maintain server-generated request IDs; do not copy raw URLs, query strings,
  headers, request/response bodies or exception messages into generic metadata.
- Background tasks should use actual job/task identifiers, not invented HTTP IDs.
  Their schemas will need context appropriate to background work.

## Verification and deployment still pending

- Exercise HTTP abort and unexpected 5xx after migration.
- Verify the remaining diagnostic families and sensitive-data exclusions in Loki.
- Verify Loki retention actually deletes old data; seven days remains a target.
- Verify restart persistence and collector recovery with existing volumes.
- Audit persistence and business-transaction integration remain a separate phase.

## Local runtime verification (2026-10-29)

- Rebuilt and recreated only the backend with the current committed code. The
  `/health/live` endpoint returned 200 before and after the restart.
- Loki's HTTP API returned `application.started`, `framework.log`, and
  `http.request.completed` for the liveness request. The development
  `nestLike` output remains multiline, but its event/category fields are
  searchable as log lines.
- Sent SIGTERM with a 40-second Docker grace period. The backend emitted
  `application.shutdown_started`, Loki received it, and the backend was started
  again successfully.
- An unauthenticated `/auth/me` request returned 401 and its status appeared in
  the HTTP completion log in Loki. A 102401-byte body sent to `/auth/login`
  returned 413 and produced the payload-too-large diagnostic in Loki.
- The oversized request included the synthetic marker
  `SAFE_LOG_REDACTION_SENTINEL_20261029`; searching Loki for it returned no
  records. This checks that this request body was not logged, not all possible
  secret-redaction paths.
- Loki config has `retention_enabled: true` and `retention_period: 168h`. Actual
  deletion of data older than seven days has not been observed.
- After backend replacement, Alloy continued querying the old Docker container
  ID during this check. Restarting Alloy refreshed discovery and the new
  backend's events then appeared in Loki. This observation is local only and
  should be rechecked during normal deployment/restart behavior.
- This did not verify production JSON output, all event families, HTTP abort,
  unexpected 5xx diagnostics, `application.shutdown_failed`, comprehensive
  sensitive-data exclusion, or actual Loki retention deletion.
