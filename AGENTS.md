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
| **Database**    | `npx prisma db push` or `npx prisma migrate dev` | Prisma 7 CLI                                                            |

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
4. **File Storage**:
   - Use `S3Service` from `@/core/storage/s3.service.js` for uploads/downloads.
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
