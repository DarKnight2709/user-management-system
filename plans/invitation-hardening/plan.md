# Invitation Module Hardening Plan

## Summary

This plan covers post-deployment verification for the invitation module. The
core implementation and unit tests are already complete; this work focuses on
production-like authorization, concurrency, queue, SMTP, and migration
coverage.

## Goals

- Verify all invitation HTTP workflows through authenticated requests.
- Prove organization permission and cross-organization isolation.
- Verify concurrent create, resend, accept, and revoke behavior against local
  PostgreSQL.
- Validate BullMQ acknowledgement, retry, duplicate-job, and worker lifecycle
  behavior with local Redis.
- Validate rendered invitation email delivery using a local SMTP sink.
- Keep all external integration suites opt-in and safe for production data.

## Constraints

- Never run destructive cleanup against application tables or production
  infrastructure.
- Database tests must use a uniquely generated local PostgreSQL schema.
- Redis and SMTP tests must use local test services or disposable containers.
- Do not log invitation tokens, token hashes, SMTP credentials, or raw error
  details.
- Preserve existing API, authorization, delivery-state, and transaction
  semantics.
- Use Vitest, npm, TypeScript, and Oxlint; do not introduce Jest.

## Implementation Phases

### Phase 1: Authenticated E2E coverage

#### P1.1 Authenticated invitation lifecycle

Extend `test/invitations.e2e-spec.ts` with a disposable authenticated fixture
and cover:

- create invitation;
- list invitation metadata;
- copy link;
- resend with queue acknowledgement;
- revoke;
- accept with the invited account;
- response envelopes, status codes, cache headers, and token redaction.

The fixture must create users and organizations in an isolated test schema or
use the repository's existing disposable database setup.

#### P1.2 Permission and scope isolation

Add E2E cases proving:

- an active member without `ORGANIZATION_MEMBER invite` cannot manage invitations;
- an inviter in organization A cannot access invitation IDs from organization B;
- deleted, suspended, and removed actors are rejected;
- accepted, revoked, and expired invitations expose the documented status
  behavior;
- malformed UUIDs are validated after authentication.

### Phase 2: PostgreSQL concurrency verification

#### P2.1 Concurrent creation

Extend
`src/modules/organizations/invitations/tests/invitations.database.integration.spec.ts`
to verify that concurrent creates for the same organization/email produce one
pending invitation and one conflict, with no orphan audit or delivery state.

#### P2.2 Concurrent lifecycle operations

Add tests for:

- accept versus revoke;
- accept versus accept;
- resend versus revoke;
- resend versus resend.

Verify serializable retry behavior, final invitation state, membership state,
delivery version monotonicity, and audit event count.

#### P2.3 Rejoin and lifecycle boundaries

Verify:

- active and suspended memberships cannot be invited;
- removed members can rejoin only through a fresh invitation;
- historical roles are revoked on rejoin;
- expired invitations cannot be accepted, copied, or resent;
- old invitations cannot restore access after removal.

### Phase 3: Redis/BullMQ integration

#### P3.1 Queue acknowledgement and duplicate jobs

Complete
`src/modules/organizations/invitations/tests/invitations.delivery.integration.spec.ts`
with local Redis/BullMQ coverage for:

- job payload contains only invitation ID and delivery version;
- deterministic job IDs deduplicate duplicate enqueue requests;
- queue acknowledgement timeout returns `emailQueued: false`;
- database status remains safe when queue insertion fails;
- stale delivery versions are ignored.

#### P3.2 Retry and worker lifecycle

Verify with a disposable queue:

- transient SMTP failure retries with configured backoff;
- permanent delivery failure reaches `FAILED`;
- successful retry reaches `SENT`;
- worker shutdown drains active work;
- unsupported jobs are unrecoverable;
- worker restart does not resend a completed version.

### Phase 4: SMTP sink integration

#### P4.1 Real SMTP sink

Run `EmailService` and `InvitationDeliveryService` against a local SMTP sink
such as Mailpit or an equivalent disposable test server. Verify:

- sender, recipient, subject, plain-text body, link fragment, and expiry;
- no HTML content or unsafe URL/file access;
- provider rejection produces `FAILED`;
- no credentials or raw provider response is logged.

No test may connect to production SMTP.

### Phase 5: Migration and schema verification

#### P5.1 Migration invariants

Extend migration verification to assert:

- `organization_invitations_pending_email_key` is partial and scoped to
  `status = 'PENDING'`;
- token hash uniqueness is enforced;
- organization and invited-by foreign keys use the intended delete behavior;
- required invitation enums and delivery columns exist;
- migration scripts do not target the application schema directly.

## Test Commands

Unit tests:

```powershell
npx vitest run src/modules/organizations/invitations/tests
```

Database integration:

```powershell
$env:RUN_DATABASE_TESTS='true'
npx vitest run src/modules/organizations/invitations/tests/invitations.database.integration.spec.ts
```

Delivery/Redis/SMTP integration:

```powershell
$env:RUN_INVITATION_DELIVERY_TESTS='true'
npx vitest run src/modules/organizations/invitations/tests/invitations.delivery.integration.spec.ts
```

E2E:

```powershell
$env:RUN_INVITATION_E2E_TESTS='true'
npm run test:e2e -- test/invitations.e2e-spec.ts
```

## Quality Gates

- `npm run build`
- `npm run lint`
- all invitation unit tests pass;
- all enabled integration tests pass;
- all enabled E2E tests pass;
- no test writes to application tables or production services;
- no sensitive invitation or SMTP data appears in logs.

## Task Breakdown

- [ ] T001 [P1.1] Extend `test/invitations.e2e-spec.ts` with an authenticated disposable fixture and full invitation lifecycle coverage.
- [ ] T002 [P1.2] Add permission, cross-organization, deleted-actor, suspended-membership, and malformed-input E2E cases.
- [ ] T003 [P2.1] Strengthen concurrent create verification in `src/modules/organizations/invitations/tests/invitations.database.integration.spec.ts`.
- [ ] T004 [P2.2] Add concurrent accept/revoke/resend lifecycle tests and audit/state assertions.
- [ ] T005 [P2.3] Add removed-member, suspended-member, expiry, and historical-role rejoin tests.
- [ ] T006 [P3.1] Replace mocked queue coverage with opt-in local Redis/BullMQ acknowledgement and duplicate-job tests.
- [ ] T007 [P3.2] Add retry, permanent failure, stale version, and worker shutdown integration tests.
- [ ] T008 [P4.1] Add local SMTP sink coverage for message content, expiry, rejection, and safe diagnostics.
- [ ] T009 [P5.1] Assert migration-level partial index, enum, column, and foreign-key invariants.
- [ ] T010 [Cross-cutting] Run build, lint, unit, integration, and E2E quality gates and record results.

## Requirement Mapping

| Requirement | Plan items | Evidence |
|---|---|---|
| Authenticated lifecycle behavior | P1.1 | `test/invitations.e2e-spec.ts` |
| Permission and organization isolation | P1.2 | `test/invitations.e2e-spec.ts` |
| Serializable invitation lifecycle correctness | P2.1, P2.2, P2.3 | `src/modules/organizations/invitations/tests/invitations.database.integration.spec.ts` |
| Queue and worker reliability | P3.1, P3.2 | `src/modules/organizations/invitations/tests/invitations.delivery.integration.spec.ts` |
| SMTP delivery correctness and safe diagnostics | P4.1 | `src/modules/organizations/invitations/tests/invitations.delivery.integration.spec.ts` |
| Database migration invariants | P5.1 | migration verification tests |

