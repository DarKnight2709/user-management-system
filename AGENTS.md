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
   - Organization ownership uses required `Organization.ownerId`. Existing organizations need real owners backfilled before adding NOT NULL. Active owner membership and ownership-transfer checks remain to be implemented.
   - Platform role assignments use `UserPlatformRole`; organization assignments use `MemberRole`. `isSystem` describes the role, not the user's authority. Do not create a dummy SYSTEM organization for platform admins.
   - Platform assignments must use roles with `isSystem = true` and `organizationId = null`; organization assignments must remain within the membership's organization. Assignment validation remains to be implemented.
   - One `PermissionsGuard` runs globally after JWT authentication and throttling. `@RequirePlatformPermissions(...)` requires every listed permission using current database assignments; deleted users, assignments, roles, permission links, and permissions are excluded. Only system roles with null organization scope count. Empty permission metadata fails closed; routes without this metadata retain their existing authorization rules.
   - `GET /users` requires platform USER read permission. Other platform operations are not yet wired to this guard. Do not treat seeding SUPER_ADMIN as automatic route protection or use organization roles to grant platform permissions.
   - `PermissionsService` in `common/services/` is exported by `GlobalModule`. Use `hasPlatformPermission(userId, permission)` for one permission or `hasPlatformPermissions(userId, permissions)` for all requirements. These return booleans for policy composition; database failures propagate. The guard delegates platform checks to this service. `DELETE /users/:id` uses self-or-platform-USER-delete authorization and deletes the target ID.
   - RBAC work is paused; resume from `RBAC_FOLLOW_UP.md`. The current `UsersService.delete` has no ownership or last-admin safeguards and no explicit already-deleted no-op. Do not claim these exist. It soft-deletes and revokes refresh tokens in a serializable transaction. Retain memberships, role assignments, and current avatars. Future safeguards must protect owners of undeleted organizations and the last effective account administrator; role revocation, organization creation/ownership transfer, and restoration need coordinated rules too.
   - The same `PermissionsGuard` also handles organization requirements. If both scope decorators are present, both checks must pass. `@RequireOrganizationPermissions(...)` requires every listed permission and a UUID `:organizationId` route parameter. It checks active membership, active/nondeleted organization and user, and active member roles/permission links/permissions. Only non-system roles belonging to the target organization count; platform admins have no bypass.
   - `Organization.ownerId` is the sole source of ownership. After active membership/user/organization checks, the owner passes organization permission checks without a role lookup. This does not bypass platform requirements or service business rules. No OWNER role needs provisioning; legacy OWNER assignments are excluded from ordinary member permissions. ADMIN/MEMBER provisioning, ownership transfer, and organization endpoints remain to be implemented.
   - Organization services must also constrain target resources (e.g. a member ID) to the authorized organization. Permission to manage organization A must never permit mutation of a resource in organization B. Routes without organization permission metadata retain their existing authorization rules.
   - `prisma/seeds/admin.seed.ts` bootstraps SUPER_ADMIN with USER read/delete and ORGANIZATION delete permissions. Credentials and required profile fields come from `SEED_ADMIN_EMAIL`, `SEED_ADMIN_USERNAME`, `SEED_ADMIN_PASSWORD`, `SEED_ADMIN_FIRST_NAME`, `SEED_ADMIN_LAST_NAME`, and `SEED_ADMIN_BIRTH_DATE`. Keep real values out of version control and logs.
   - Bootstrap validates a minimum 15-character password, at most 72 UTF-8 bytes, and a non-whitespace character. It preserves existing admin credentials/profile, rejects ordinary-account promotion, soft-deleted accounts, and revoked admin assignments, and restores seeded role/permission records. Do not use it as a password-reset operation or run it at app startup.
   - Review migrations and generate the client before bootstrap. Never run database-changing seeds as a routine lint/build check; bootstrap requires explicit task authorization. Log only safe bootstrap messages or Prisma error codes, not raw database errors or environment values.
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

---

## 4. Git & Commit Guidelines

- Strictly adhere to [GIT_GUIDELINES.md](file:///d:/VscodeProjects/user-management-system/GIT_GUIDELINES.md).
- Follow **Conventional Commits**:
  - `feat(scope): ...`
  - `fix(scope): ...`
  - `docs(scope): ...`
  - `chore(scope): ...`
- Subject must be lowercase, in imperative mood, with no trailing period.
- Never commit secrets, `.env`, or build artifacts (`dist/`, `*.tsbuildinfo`).

---

## 5. Strict Prohibitions (Don'ts)

- ❌ **DO NOT** use CommonJS `require()` or `module.exports`.
- ❌ **DO NOT** install or run `jest` or `eslint` (this repo uses `vitest` and `oxlint`).
- ❌ **DO NOT** install TailwindCSS unless explicitly instructed by the user.
- ❌ **DO NOT** hardcode credentials, URLs, or secrets in code.
