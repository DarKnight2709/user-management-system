# Organization invitations

Files are grouped by type: `controllers/`, `services/`, `dto/`, `workers/`,
`interfaces/`, `constants/`, and `tests/`. Shared email job enums live in
`src/common/enums/`. The queue module remains at the feature root.

This implementation uses one `organization_invitations` table, BullMQ, and
explicit resend/copy-link recovery. There is no transactional outbox or automatic
database-to-Redis reconciliation.

## Routes

All routes require authentication. Management routes require active organization
membership and ORGANIZATION_MEMBER invite, or the active owner. Services recheck
authorization inside serializable transactions. Platform roles grant no bypass.

| Method | Route                                                             | Body / behavior                                                                        |
| ------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| POST   | `/organizations/:organizationId/invitations`                      | `{ "email": "member@example.com" }`; creates a 7-day MEMBER-only invitation            |
| GET    | `/organizations/:organizationId/invitations?page=1&limit=20`      | Paginated metadata; no token hashes or links                                           |
| POST   | `/organizations/:organizationId/invitations/:invitationId/resend` | Empty body; 60-second cooldown from initial request and each resend, maximum 5 resends |
| POST   | `/organizations/:organizationId/invitations/:invitationId/link`   | Copy the same link; does not email, rotate the token, reset cooldown, or extend expiry |
| DELETE | `/organizations/:organizationId/invitations/:invitationId`        | Revoke; repeat revoke returns 204; accepted invitations cannot be revoked              |
| POST   | `/invitations/accept`                                             | `{ "token": "…" }`; authenticated account email must match the invited email           |

Route UUIDs are validated. Arbitrary role/owner/organization body fields are
rejected. Create/resend return `{ "emailQueued": true | false }`. Refresh the
invitation list to obtain invitation IDs and metadata; use the protected copy-link
endpoint to obtain `inviteLink`. Create returns 201 and resend returns 200; neither
response proves email delivery.
`emailQueued: false` means queue acknowledgement was not confirmed: copy the link
or request resend after cooldown. `deliveryStatus` distinguishes NOT_QUEUED,
QUEUED, SENT, FAILED; SENT means SMTP accepted the recipient, not inbox delivery.

Acceptance atomically consumes the invitation and assigns the active, local MEMBER
role. New members receive a new ACTIVE membership. Previously removed ACTIVE
members reuse their existing membership only through an invitation created after
removal; acceptance revokes all historical role assignments and activates only
MEMBER. Active or suspended memberships and deleted accounts cannot be invited.
Old invitations cannot be accepted, resent, or copied after removal; creating a
fresh invitation revokes stale pending invitations. Rejoining never restores ADMIN
or custom roles. Pending duplicates are blocked by a partial
unique index; expired pending rows are marked EXPIRED when creating a replacement.
Expired status in list responses is derived immediately, without a cleanup job.

Possession of the invitation capability plus matching account email is required.
The application does not yet have a general verified-email feature: do not label
this as account-wide email verification. A link shared by an authorized inviter
is intentionally an alternate delivery channel.

## Configuration

The existing `prisma7.config.ts` is required for migrations:

```powershell
npx prisma migrate deploy --config prisma7.config.ts
npx prisma generate --config prisma7.config.ts
```

Copy-link mode requires `FRONTEND_URL` and a separate random
`INVITATION_TOKEN_SECRET` of at least 64 non-whitespace characters. Do not reuse
JWT secrets. Keep this secret stable and private. Tokens are HMAC-SHA256 of a
domain-separated invitation ID, allowing authorized reconstruction for copy and
resend. Only SHA256(token) is stored; no plaintext token or role string is stored
in the invitation table. Secret rotation invalidates existing capability links
and requires deliberate revocation/reissue; it is not automatic.

Links use `/invitations/accept#token=…`. The frontend must read the URL fragment,
keep the capability through login/registration as necessary, and POST it in the
accept body after authentication. Do not log tokens or put them in HTTP query
parameters. The backend supplies the link; clipboard/UI integration belongs to
the frontend and is not implemented in this repository. Capability responses use
Cache-Control: no-store.

Email infrastructure always starts with the application. Configure
REDIS_HOST, REDIS_PORT, optional REDIS_PASSWORD, REDIS_QUEUE_PREFIX,
SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_FROM, and optional SMTP_USER/SMTP_PASSWORD
in private `.env`. User/password must be configured together. Use a trusted SMTP
server; authenticated production SMTP must use TLS. SMTP_SECURE=true is for
implicit TLS (typically 465); false permits STARTTLS (typically 587).
SMTP connection timeout is 20 seconds, including DNS resolution. Greeting timeout
is 5 seconds and socket inactivity timeout is 10 seconds.

Local Redis setup:

```powershell
docker compose up -d redis
```

Compose publishes Redis only on loopback using REDIS_PORT (default 6379) and
persists AOF with noeviction. During local verification a project Redis container
was started on 6381 to avoid VocaLab's Redis; match your private REDIS_PORT.
Production Redis persistence, authentication/TLS, monitoring, and worker drain
configuration remain deployment work. Do not expose this development Redis to
the public network.

## Queue dashboard

Bull Board is mounted read-only at `/queues` only when validated
`NODE_ENV=development`. QueueDashboardModule waits for environment loading before
registering both the root dashboard and invitation queue adapter. Production/test
register neither; UI/API/assets return 404. The queue and worker run in every environment.
The local development dashboard has no separate login; keep development instances
private. Deployments must explicitly set `NODE_ENV=production`.

## Failure semantics

- Invitation and membership writes use bounded serializable conflict retries;
  queue/SMTP calls run after commit, never inside retried transactions.
- API and worker run in the same NestJS process using the VocaLab-style Nest
  integration: AppModule configures BullModule.forRootAsync; InvitationQueueModule
  registers the queue; InvitationEmailService uses InjectQueue to produce jobs;
  EmailNotificationWorker uses Processor/WorkerHost/OnWorkerEvent to consume them.
  InvitationDeliveryService checks lifecycle state and records delivery results;
  EmailService owns Nodemailer SMTP. Worker concurrency is 3.
- InvitationQueueModule is always imported and queue injection is required.
  FRONTEND_URL, INVITATION_TOKEN_SECRET, REDIS_HOST, SMTP_HOST, and SMTP_FROM are
  required on every startup. Queue failures still return emailQueued=false;
  resend and copy-link recovery remain available.
- Nest manages queue/worker lifecycle. The worker also drains in onModuleDestroy
  before database teardown; SMTP closes in onApplicationShutdown. Real Linux
  signal/drain behavior still requires deployment verification.
- Jobs contain only invitation ID and delivery version. IDs use
  `<invitationId>-<version>` (no colon). Three attempts use exponential backoff.
  Completed jobs are removed immediately; failed jobs are retained for up to seven
  days or 1,000 jobs, with cleanup performed as subsequent jobs fail. This policy
  applies to newly enqueued jobs, not existing retained jobs.
- Delivery warnings identify the invitation ID, delivery version, failure stage
  (database read, link configuration, SMTP send, or recording delivery state), and
  allowlisted error codes. SMTP response numbers may be included, but never raw
  error messages, stacks, SMTP responses, credentials, tokens, or recipient addresses.
  Worker failure logs include the attempt number and configured attempt limit.
- Worker rechecks pending/unexpired invitation, current version, active
  organization, and SENT state before delivery. It records SENT only after SMTP
  accepts. Safe errors contain no email/token/SMTP credentials.
- Queue acknowledgement has a 3-second deadline. This is not cancellation: a
  delayed enqueue might still complete after the API reports unconfirmed status.
- A crash between DB commit and enqueue leaves a saved invitation without a job.
  A crash after SMTP acceptance but before SENT is recorded can cause a duplicate
  email on retry. Resend can also overlap an already-running delivery. Revoking
  cannot retract an email already in flight. These are accepted limits of this
  non-outbox first version; expired/revoked links still cannot be accepted.
- Redis job loss or exhausted retries is recovered manually through resend or
  copy link. No periodic worker scans the table for unqueued invitations.

## Verification

Invitation unit tests mock database, queue, and SMTP boundaries. They cover input
validation, token/link generation, acceptance with valid/unknown tokens and a
changed secret, delivery filtering, and queue failure handling. Dashboard tests
verify omitted routes outside development. No email is sent by these tests.

```powershell
npm test
npx tsc -p test/tsconfig.deletion.json
```

The existing PostgreSQL integration suite is opt-in with RUN_DATABASE_TESTS=true
and uses a disposable local schema. It does not currently cover invitation flows.
There is no RUN_EMAIL_TESTS fixture in the current suite.

Invitation database concurrency, real Redis-to-worker-to-SMTP processing,
external SMTP delivery, inbox placement, frontend accept/clipboard UI, and real
Linux signal handling remain unverified by the current invitation tests.
