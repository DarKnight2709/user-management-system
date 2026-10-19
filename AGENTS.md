# AI Agent Guidelines — User Management System

This document provides essential context, architectural rules, and operational guidelines for AI coding agents (Antigravity, Cursor, Claude Code, Copilot) working on this repository.

---

## 1. Runtime & Environment

- **Node.js & Module System**: Pure **ES Modules** (`"type": "module"` in `package.json`).
  - **CRITICAL**: Every relative TypeScript import MUST end with the `.js` extension (e.g., `import { AppModule } from './app.module.js';`).
  - Path alias `@/*` maps to `./src/*` (e.g., `@/common/guards/jwt-auth.guard.js`).
- **Framework**: **NestJS 12**.
- **Package Manager**: **`npm`** only. Do NOT use `yarn` or `pnpm`.

---

## 2. Standard Commands

Always use the existing scripts defined in `package.json`:

| Task            | Command                                          | Note                                                                    |
| :-------------- | :----------------------------------------------- | :---------------------------------------------------------------------- |
| **Development** | `npm run start:dev`                              | Watches for changes                                                     |
| **Build**       | `npm run build`                                  | Compiles using `nest build`                                             |
| **Lint**        | `npm run lint`                                   | Runs `oxlint --type-aware src/ test/` (**Zero warnings/errors policy**) |
| **Format**      | `npm run format`                                 | Runs `prettier --write`                                                 |
| **Unit Tests**  | `npm test`                                       | Runs `vitest run` (**DO NOT use Jest**)                                 |
| **E2E Tests**   | `npm run test:e2e`                               | Runs `vitest run --config ./vitest.config.e2e.ts`                       |
| **Database**    | `npx prisma migrate dev --config prisma7.config.ts` | Review generated migration SQL before applying it                    |
| **Generate Client** | `npx prisma generate --config prisma7.config.ts` | Run after schema changes                                           |
| **Admin Bootstrap** | `npm run prisma:seed` | Explicit operation; requires private `SEED_ADMIN_*` values                  |
| **Organization Permission Catalog** | `npm run prisma:seed:organization-permissions` | Explicit operation; DATABASE_URL only, no admin credentials |

---

## 3. Architecture & Code Conventions

### Project Layout

```text
src/
├── common/           # Cross-cutting concerns: guards, interceptors, filters, pipes, decorators
├── core/             # Infrastructure: config/env validation, database (Prisma), storage (S3)
├── modules/          # Business feature domains (auth, users, global)
│   ├── auth/         # JWT + Passport authentication, strategies, login DTO
│   └── users/        # User CRUD, avatar upload, DTOs, interfaces
├── app.module.ts     # Root module
└── main.ts           # Application bootstrap & Swagger documentation setup
```

### Coding Conventions

1. **OpenAPI / Swagger**:
   - `main.ts` creates and registers Swagger only when validated `NODE_ENV` equals `development`; production/test have no Swagger UI or raw JSON/YAML endpoints. Keep its startup log conditional too. NODE_ENV defaults to development, so deployment must explicitly set production; `npm run start:prod` alone does not set the environment.
   - NestJS Swagger CLI plugin is enabled in `nest-cli.json` (`classValidatorShim: true`).
   - Do **NOT** add manual `@ApiProperty()` to standard DTOs unless specifying multipart schemas or binary files.
   - Controllers should only include essential decorators:
     - `@ApiTags('DomainName')`
     - `@ApiOperation({ summary: 'One-line description' })`
     - `@ApiBearerAuth()` for routes guarded by `JwtAuthGuard`.
2. **DTOs & Validation**:
   - Use `class-validator` and `class-transformer`.
   - Keep DTOs in `dto/` directory matching `*.dto.ts`.
3. **Database Access**:
   - Always inject `PrismaService` from `@/core/database/prisma.service.js`.
   - Standalone seeds use the generated `PrismaClient` with `PrismaPg`, initialize it in `prisma/seed.ts`, and disconnect in `finally`. The entry point is configured in `prisma7.config.ts` and runs through `tsx`.
   - Organization ownership uses required `Organization.ownerId`. Existing organizations need real owners backfilled before adding NOT NULL. Creation provisions active owner membership; ownership transfer preserves active membership and assigns MEMBER to the former owner atomically.
   - Platform role assignments use `UserPlatformRole`; organization assignments use `MemberRole`. `isSystem` describes the role, not the user's authority. Do not create a dummy SYSTEM organization for platform admins.
   - Platform assignments must use roles with `isSystem = true` and `organizationId = null`; organization assignments must remain within the membership's organization. Assignment validation remains to be implemented.
   - One `PermissionsGuard` runs globally after JWT authentication and throttling. `@RequirePlatformPermissions(...)` requires every listed permission using current database assignments; deleted users, assignments, roles, permission links, and permissions are excluded. Only system roles with null organization scope count. Empty permission metadata fails closed; routes without this metadata retain their existing authorization rules.
   - `GET /users` requires platform USER read permission through the guard and `UsersService.findAllForActor`. The service rechecks the active actor (401) and permission (403) in the same transaction snapshot as the page/count; SUPER_ADMIN has no permission bypass. Return `{ items, total, page, limit }` inside the standard envelope's data, excluding deleted users and password hashes and replacing avatarKey with avatarUrl. Pagination defaults to page 1/limit 20; integer bounds are page 1–1,000,000 and limit 1–100 (422 otherwise). Sort createdAt descending then id ascending. Do not restore an unguarded list method. Do not treat seeding SUPER_ADMIN as automatic route protection or use organization roles to grant platform permissions.
   - `GET /users/:id` delegates actorId/targetId to `UsersService.findOneForActor`: active self-access or platform USER read, with no SUPER_ADMIN bypass. Authorization precedes target lookup in one transaction; inactive/missing actor is 401, unauthorized cross-account read is 403, authorized missing/deleted target is 404. Query omits hashedPassword; response replaces avatarKey with avatarUrl. Keep `findOne(id)` as an internal active-user lookup for JWT validation/avatar upload; do not route external account reads through it.
   - `PermissionsService` in `common/services/` is exported by `GlobalModule`. Single/all platform permission methods return booleans and accept an optional Prisma transaction client; pass that client for checks within a write transaction. Database failures propagate. The guard delegates platform checks to this service.
   - `DELETE /users/:id` passes authenticated actorId and targetId into `UsersService.delete`. The service rechecks the active actor (401), authorizes self-or-platform-USER-delete (403) before target lookup, returns 404 for missing target and no-op/204 for an authorized already-deleted target. Authentication still rejects a deleted user retrying their own deletion; idempotency does not bypass authentication.
   - In the same serializable transaction with conflict retries, `assertDeletionSafeguards` blocks owners of any undeleted organization (including inactive ones) and any target with an active global system SUPER_ADMIN assignment with 409, including self-deletion. Protection does not depend on the role permission set or other admin count. Ordinary platform admins can be deleted under the normal permission/ownership rules; the old last-effective-admin count was removed. Deletion and refresh-token revocation are atomic. Retain memberships, role assignments, and avatars. Audit recording is deferred by the user. Real database deletion/concurrency scenarios were verified in an isolated temporary schema; see `USER_DELETION_VERIFICATION.md` for limits. Future organization creation/ownership transfer, role revocation, and restoration must enforce compatible invariants too.
   - The serializable retry helper recognizes Prisma P2034 and PostgreSQL adapter DriverAdapterError cause.originalCode 40001/40P01. Commit-time serialization failures may bypass Prisma's wrapper; preserve bounded retries for both forms. Do not retry arbitrary driver errors or run external side effects inside a retried transaction.
   - The same `PermissionsGuard` also handles organization requirements. If both scope decorators are present, both checks must pass. `@RequireOrganizationPermissions(...)` requires every listed permission and a UUID `:organizationId` route parameter. It checks active membership, active/nondeleted organization and user, and active member roles/permission links/permissions. Only non-system roles belonging to the target organization count; platform admins have no bypass.
   - `Organization.ownerId` is the sole source of ownership. After active membership/user/organization checks, the owner passes organization permission checks without a role lookup. This does not bypass platform requirements or service business rules. No OWNER role needs provisioning; legacy OWNER assignments are excluded from ordinary member permissions. ADMIN/MEMBER provisioning is implemented during creation; ownership transfer is implemented with active membership safeguards. Organization deletion remains pending.
   - GET /organizations/:organizationId requires organization ORGANIZATION read via the global guard and OrganizationsService.findOneForActor. PermissionsService.hasOrganizationPermissions owns the shared organization query and accepts an optional transaction client; empty requirements fail closed and database errors propagate. The service rechecks an active actor (401) and permission inside the read transaction. Missing/inaccessible organizations both return 403; the guard validates malformed UUIDs as 400. Return only id/name/slug/ownerId/isActive/createdAt/updatedAt, never member/role data. Owners still need active membership; platform admins have no bypass. GET /organizations uses OrganizationsService.findAllForActor and PermissionsService.findAuthorizedOrganizationIds to apply the same access rules before page/count inside one serializable transaction. It returns data {items,total,page,limit}, default page 1/limit 20; integer bounds page 1–1,000,000 and limit 1–100 (422). Empty authorized sets return 200 with empty items/zero total, never a platform bypass. Order by createdAt descending then id ascending. No single-organization decorator belongs on the list route. Bulk authorization checks same-organization role scope against each membership, including malformed assignments; the detail check delegates to this same method constrained to one organization. Bulk authorization work grows with membership count; do not claim fully bounded query cost from response pagination alone.
   - PATCH /organizations/:organizationId updates name only through UpdateOrganizationDto (PickType of CreateOrganizationDto, required trimmed name 1–100). Empty bodies and unknown/protected fields return 422. Global ORGANIZATION update metadata and OrganizationsService.updateForActor enforce active membership/user/organization, owner-or-active-same-organization update grants, and no platform bypass. Actor state (401), permission (403), and the allowlisted write share one serializable transaction; malformed HTTP UUIDs return 400 and nonexistent/inaccessible organizations both 403. Return the shared organization detail select. Slug, ownerId, activation/deletion, and role changes are excluded from this operation.
   - GET /organizations/:organizationId/members is owned by OrganizationMembersController/Service in OrganizationsModule. Global ORGANIZATION_MEMBER read metadata and service authorization inside one serializable transaction are required. Directory rows/count must constrain organizationId, ACTIVE status, nondeleted membership and user. Return data {items,total,page,limit}; defaults/bounds match organization lists, ordered membership createdAt ascending then id ascending. Items expose membership id/status/createdAt, isOwner from organization.ownerId, user id/username/firstName/lastName, and active local role id/name labels. Member-read permits these labels only, not permission details. Exclude revoked, system, cross-organization, deleted, and legacy OWNER roles; never select email, birthDate, password hashes, keys, or tokens. Missing/deleted actors 401, invalid HTTP UUIDs 400, inaccessible/nonexistent organizations 403, invalid pagination 422. Invited/suspended memberships are excluded from this directory; management views remain future work.
   - Organization invitations use exactly one new OrganizationInvitation table plus BullMQ (no outbox). See src/modules/organizations/invitations/README.md for routes and recovery semantics. Management requires ORGANIZATION_MEMBER invite; accept requires a live capability and matching active account email, never client-selected roles. Acceptance/membership/MEMBER assignment are atomic with serializable retries; retained memberships are not restored. Enqueue/SMTP are outside DB transactions. A partial unique index protects pending organization/email pairs; expired rows are replaced deliberately. Tokens are HMAC-derived with a separate stable INVITATION_TOKEN_SECRET, hashed in DB, and reconstructed only for authorized copy/resend; do not log/serialize hashes or secrets. Links carry tokens in fragments; frontend must POST the accept token. Resend cooldown starts at initial send, minimum 60 seconds, maximum 5 resends, same token/expiry; copy does not email. Return explicit emailQueued/deliveryStatus, not a sent-success claim. Use the VocaLab-style @nestjs/bullmq integration (v12 for Nest12): AppModule BullModule.forRootAsync, InvitationQueueModule registerQueue, InvitationEmailService InjectQueue producer, EmailNotificationWorker Processor/WorkerHost/OnWorkerEvent, InvitationDeliveryService lifecycle checks, and EmailService SMTP. InvitationQueueModule is always imported; producer queue injection is required. FRONTEND_URL, INVITATION_TOKEN_SECRET, REDIS_HOST, SMTP_HOST, and SMTP_FROM are required at startup. Nest manages connections; worker drains in onModuleDestroy and SMTP closes onApplicationShutdown. API/worker share one process, safe errors, versioned jobs without colons, no premature sent marker. Redis port is configurable in local Compose; do not use VocaLab queues for tests. Real pipeline tests use generated queue prefixes and local SMTP sink. Delivery gaps, possible duplicate email, in-flight revocation limits, frontend integration and provider delivery remain documented. Do not add an outbox or auto-reconciliation unless the user changes this decision.
   - Bull Board is registered by QueueDashboardModule, imported by InvitationQueueModule, only after ConfigModule.envVariablesLoaded and only for NODE_ENV=development. Both root dashboard and queue adapter are omitted in production/test (UI/API/assets return 404). Queue and worker remain enabled in all environments. Route: /queues; adapter uses INVITATION_EMAIL_QUEUE and readOnlyMode. The local development dashboard has no separate authentication and its Express routes bypass Nest controller guards; keep development instances private. NODE_ENV defaults to development, so deployments must explicitly set production.
   - Organization services must also constrain target resources (e.g. a member ID) to the authorized organization. Permission to manage organization A must never permit mutation of a resource in organization B. Routes without organization permission metadata retain their existing authorization rules.
   - `prisma/seeds/admin.seed.ts` bootstraps SUPER_ADMIN with USER read/delete and ORGANIZATION delete permissions. Credentials and required profile fields come from `SEED_ADMIN_EMAIL`, `SEED_ADMIN_USERNAME`, `SEED_ADMIN_PASSWORD`, `SEED_ADMIN_FIRST_NAME`, `SEED_ADMIN_LAST_NAME`, and `SEED_ADMIN_BIRTH_DATE`. Keep real values out of version control and logs.
   - Bootstrap validates a minimum 15-character password, at most 72 UTF-8 bytes, and a non-whitespace character. It preserves existing admin credentials/profile, rejects ordinary-account promotion, soft-deleted accounts, and revoked admin assignments, and restores seeded role/permission records. It refuses a different active SUPER_ADMIN holder when bootstrap email changes. This is not a database singleton constraint; future role-assignment and reserved-role mutation operations must preserve that policy. Do not use it as a password-reset operation or run it at app startup.
   - Review migrations and generate the client before bootstrap. Never run database-changing seeds as a routine lint/build check; bootstrap requires explicit task authorization. Log only safe bootstrap messages or Prisma error codes, not raw database errors or environment values.
   - `prisma/seeds/organization-permissions.seed.ts` seeds 11 permissions: ORGANIZATION read/update, ORGANIZATION_MEMBER read/invite/remove, and ORGANIZATION_ROLE create/read/update/delete/assign/revoke through the permissions-only mode of `prisma/seed.ts`. One transaction upserts by action/resource, updating descriptions while preserving soft-deleted state. ORGANIZATION delete remains platform-only in admin.seed.ts; ownership transfer has no organization permission entry. Both owner operations require explicit ownerId service checks. It never assigns permissions or creates roles/users and needs no SEED_ADMIN_* values. Planned ADMIN defaults: organization read/update, member read/invite/remove, role read; MEMBER defaults: organization/member/role read. Owner authority remains ownerId. Future services must keep organization deletion/ownership transfer and built-in ADMIN assignment/revocation owner-only, protect built-in roles, enforce organization scope, and prevent unauthorized permission delegation. Catalog entries do not implement these safeguards. POST /organizations provisions the organization, active owner membership, and scoped ADMIN/MEMBER roles atomically using serializable retries. The authenticated caller is ownerId; no owner role assignment is created. Required default permissions must be active or creation fails with 503. Missing/deleted actors receive 401 and taken slugs 409, including soft-deleted organizations. Global authentication/IP throttling and DTO validation apply. Organization deletion remains unimplemented; ownership transfer is implemented; custom role listing/creation/editing/deletion are implemented.
   - Organization membership controller/service and query DTO/tests live in modules/organizations/members/ (DTOs under members/dto/). They remain registered in OrganizationsModule.
   - DELETE /organizations/:organizationId/members/:memberId soft-deletes a scoped membership under ORGANIZATION_MEMBER remove permission, with service authorization and target safeguards inside a serializable transaction. The owner is never removable. Removal requires permission plus hierarchy OWNER > ADMIN > custom roles > MEMBER. Non-owners must outrank the target; no peer/higher/self removal. Highest active non-system same-organization role counts; roleless users have MEMBER level and legacy OWNER assignments never confer ownership. Keep membership role assignments, user account and refresh sessions. Authorized retries return 204; platform permissions grant no bypass. Membership deletedAt immediately excludes organization authorization. Future role assignment/ownership transfer/restoration must preserve these rules. Leaving and audit are separate work.
   - Organization role read endpoints live in modules/organizations/roles and remain registered in OrganizationsModule. GET roles returns paginated active local roles (excluding legacy OWNER) with active organization catalog grants; GET roles/permissions returns the active catalog. Both require ORGANIZATION_ROLE read via guard and service serializable recheck. No platform bypass. The shared catalog in common/constants/organization-permissions.constant.ts drives the seed and read filters; listing catalog entries never authorizes delegation. POST roles requires ORGANIZATION_ROLE create (method metadata overrides class read), canonical uppercase names with reserved OWNER/ADMIN/MEMBER, active catalog permissions and no delegation beyond caller authority. ORGANIZATION delete/transfer-ownership are absent from the catalog and rejected by the allowlist with 422. Deleted names stay reserved. Creation and links share a serializable transaction; uniqueness conflicts return 409. Empty permissions are allowed and no members are assigned. PATCH roles/:roleId requires ORGANIZATION_ROLE update; accepts name and/or permissionIds, omitted unchanged, [] clears, empty/null rejected. Built-in OWNER/ADMIN/MEMBER immutable. Non-owners must hold current target grants plus replacements; existing non-catalog grants require owner editing. Soft-revoke removed links and explicitly restore requested ones, retain assignments. Atomic serializable updates ensure replacements do not merge under concurrency. DELETE roles/:roleId requires ORGANIZATION_ROLE delete and current role-grant authority, scoped target and immutable built-in checks. Soft-delete the role only, retaining grants/assignments, with serializable retries. Authorized repeated deletion returns 204; never bypass current actor/membership checks. Deleted names remain reserved. Concurrent deletion/update must never restore the role. PUT/DELETE organizations/:organizationId/members/:memberId/roles/:roleId live in members/MemberRolesController/Service; require ORGANIZATION_ROLE assign/revoke with active caller/membership/org and scoped active target membership/user/role. Only ownerId may assign/revoke ADMIN; never assign OWNER/system roles or roles with non-catalog grants. Non-owners must hold all selected role grants. Additive assignments preserve other roles; revoke only soft-deletes MemberRole, explicit reassignment restores it. Idempotent changes and authorization share a serializable transaction. Assigning MEMBER does not demote ADMIN. No platform bypass. Organization deletion remains unimplemented; ownership transfer is implemented.
   - GET /organizations/:organizationId/me/permissions has no organization permission metadata: any active member may inspect their own effective permissions, even an empty array. OrganizationsService wraps PermissionsService.getEffectiveOrganizationPermissions in a serializable transaction. Missing/deleted users 401, inaccessible organization/membership 403; no platform bypass. Return deduplicated active catalog grants with id/resource/action. Owners get only the active organization catalog. Every returned ID is a real permission UUID; do not return computed ORGANIZATION delete/transfer-ownership capabilities or platform deletion IDs. Cache-Control no-store. This response does not replace server authorization/delegation or ownerId checks.
   - POST /organizations/:organizationId/transfer-ownership is owned by ownership/OrganizationOwnershipController/Service. Only ownerId with active user/membership/org may transfer; no role permission metadata or platform bypass. Body memberId is a local active membership UUID, not a user ID; recipient user must be nondeleted. Self transfer 409, invalid target 404, unavailable MEMBER 503 with rollback. Serializably update ownerId and ensure former owner's active local MEMBER assignment, restoring only that assignment if revoked; retain all other roles and never auto-grant ADMIN. Return 200 {id,ownerId,previousOwnerId}. Retrying as former owner 403. Forced overlap tests cover competing transfers, recipient account deletion and member removal. No audit/email/recipient acceptance yet. Account/member deletion safeguards must remain compatible with this transaction.
4. **File Storage**:
   - Use `S3Service` from `@/core/storage/s3.service.js` for uploads/downloads.
   - `S3_PUBLIC_URL` is the public storage origin without the bucket. URL construction appends the configured bucket and the exact stored object key.
   - New avatar keys are filenames without an `avatars/` prefix. Preserve existing keys unless their objects are moved too.
   - Local Compose initialization creates `avatars` and applies `docker/minio/avatars-policy.json`. Keep the bucket name consistent with `S3_BUCKET` and the policy resource ARNs.
   - The policy permits anonymous object reads and bucket-location reads, but grants no anonymous writes, deletes, or listing. Public avatar URLs do not require application authentication.
   - Bucket creation belongs in infrastructure setup, not the upload request. Rerunning initialization preserves objects and replaces the bucket policy with the checked-in JSON.
   - `minio-init` reuses the MinIO image's bundled `mc` and sets `pull_policy: never`. The image must already be available locally; fresh-machine image provisioning remains unresolved. Do not claim registry availability or fresh-install verification based only on cached images.
   - Do not delete buckets or storage volumes as a routine verification step; stored database keys would point to missing objects.
5. **Exception Handling**:
   - Throw standard NestJS HTTP exceptions (`NotFoundException`, `ConflictException`, etc.).
   - Global filters handle Prisma and general exceptions.
6. **Application Lifecycle**:
   - Keep `app.enableShutdownHooks()` in `main.ts` so supported termination signals invoke lifecycle cleanup. Forced termination cannot run these hooks. Verify worker/resource ordering and in-flight behavior separately; do not infer Linux SIGTERM verification from Windows Ctrl+C checks.

---

Health conventions: `HealthModule` owns `/health/live`, a public liveness probe
with no database/storage queries. It returns the standard envelope with
`data.status = "ok"`. Its named ip/account/userId throttling policies are skipped
to avoid probe-induced 429 responses. `/health/ready` checks PostgreSQL via a
read-only users-table query: 200 when available, safe 503 on errors/deadline.
Transaction maxWait is 1 second, timeout is 2 seconds, and response deadline is
3 seconds. Concurrent probes share in-flight database work; the response deadline
alone does not cancel driver work. HealthService marks shutdown in onModuleDestroy;
readiness rejects new probes with safe 503 and rechecks after in-flight queries.
Shutdown failures must not be misreported as database failures. Liveness remains
independent. No routing-propagation grace period is implemented; deployment drain
timing and real signal behavior require separate verification. Storage readiness remains pending.
Do not treat the root greeting or liveness as dependency verification.

## 4. Git & Commit Guidelines

- Strictly adhere to [GIT_GUIDELINES.md](file:///d:/VscodeProjects/user-management-system/GIT_GUIDELINES.md).
- Follow **Conventional Commits**:
  - `feat(scope): ...`
  - `fix(scope): ...`
  - `docs(scope): ...`
  - `chore(scope): ...`
- Subject must be lowercase, in imperative mood, with no trailing period.
- Never commit secrets, `.env`, or build artifacts (`dist/`, `*.tsbuildinfo`).
- Keep README feature/status claims aligned with implemented code. Distinguish permission infrastructure from protected endpoints, access JWTs from refresh-session revocation, and local Compose from production deployment. Do not label the project production-ready while documented authorization/deployment work remains unfinished.
- Deletion regression tests are in `src/core/database/prisma.service.spec.ts` and `test/users-deletion.integration.spec.ts`. The database suite is opt-in with RUN_DATABASE_TESTS=true and uses a uniquely generated temporary schema on local PostgreSQL, removed after execution. Never point it at application tables or remote hosts. Type-check it with `npx tsc -p test/tsconfig.deletion.json`. User has authorized adding these deletion regression tests; auditing remains deferred.

---

## 5. Strict Prohibitions (Don'ts)

- ❌ **DO NOT** use CommonJS `require()` or `module.exports`.
- ❌ **DO NOT** install or run `jest` or `eslint` (this repo uses `vitest` and `oxlint`).
- ❌ **DO NOT** install TailwindCSS unless explicitly instructed by the user.
- ❌ **DO NOT** hardcode credentials, URLs, or secrets in code.

The user will manually clean legacy owner-only permission records/grants in the application database. Do not run cleanup or seeds for this task. Preserve platform ORGANIZATION delete grants and the admin seed description; catalog changes alone do not revoke existing grants.
