# Logging rollout inventory

Inventory date: 2026-10-29. This file tracks code inspection, not production verification.

## Completed Auth scope

- Selected Auth security events use LoggingService.security().
- auth.refresh_failed and logout-all's auth.logout_failed use application().
- Single-family logout infrastructure failures use
  auth.logout_session_failed; invalid token outcomes are excluded.
- Both operational events are emitted outside transaction retries and rethrow
  the original failure. Raw errors and tokens are excluded from their payloads.
- Single-family logout has no dedicated operational failure event yet.

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
Winston; none are currently used as application producers in `src/`.

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

- Exercise HTTP completion/abort, expected 4xx and unexpected 5xx after migration.
- Query Loki by category/event/request ID and check sensitive-data exclusions.
- Verify Loki retention actually deletes old data; seven days remains a target.
- Verify restart persistence and collector recovery with existing volumes.
- Audit persistence and business-transaction integration remain a separate phase.
