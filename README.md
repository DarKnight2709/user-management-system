# User Management System API

[![NestJS](https://img.shields.io/badge/NestJS-12-ea2845?style=flat-square&logo=nestjs&logoColor=white)](https://nestjs.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-4169e1?style=flat-square&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Prisma](https://img.shields.io/badge/Prisma-7-2d3748?style=flat-square&logo=prisma&logoColor=white)](https://www.prisma.io/)
[![Swagger](https://img.shields.io/badge/Swagger-OpenAPI%203.0-85ea2d?style=flat-square&logo=swagger&logoColor=black)](https://swagger.io/)
[![Vitest](https://img.shields.io/badge/Vitest-Testing-fcc72b?style=flat-square&logo=vitest&logoColor=black)](https://vitest.dev/)
[![Oxlint](https://img.shields.io/badge/Oxlint-Linter-00d1b2?style=flat-square)](https://oxc.rs/)

A production-ready RESTful API backend built with **NestJS 12**, **PostgreSQL 17**, and **Prisma 7**. Featuring JWT authentication, S3-compatible file storage (MinIO / AWS S3) with magic-byte file validation, automated OpenAPI documentation, and local container orchestration with Docker Compose.

---

## 🌟 Key Features

- **Authentication & Security**:
  - Passport Local strategy for credential verification and secure bcrypt password hashing.
  - Stateless JWT token issuance and verification with `JwtAuthGuard`.
  - Type-safe `@CurrentUser()` custom decorator for extracting authenticated identity.
- **User Management (CRUD)**:
  - Full user lifecycle operations (create, read, update, delete).
  - Robust request validation powered by `class-validator` and `ParseUUIDPipe`.
- **S3-Compatible Avatar Storage**:
  - Single-part image uploads via Multer interceptor.
  - Deep file inspection using custom JPEG magic-byte header validator (`IsJpegValidator`).
  - Storage integration with AWS S3 / MinIO via `@aws-sdk/client-s3` and public URL resolution.
- **Enterprise-Grade Architecture**:
  - Clean separation: `common/` (cross-cutting), `core/` (infrastructure), and `modules/` (domain logic).
  - Global Prisma exception filter mapping database constraints to standard HTTP status codes.
  - Centralized request/response logging middleware and transform interceptors.
- **Auto-Generated Documentation**:
  - Interactive OpenAPI/Swagger UI served at `/api-docs` with JWT Bearer authorization support.
- **Modern Developer Tooling**:
  - Native Node.js ES Modules (`"type": "module"`).
  - Ultra-fast static analysis via **Oxlint** and unit testing via **Vitest**.

---

## 🏗️ System Architecture

```mermaid
flowchart TD
    Client(["HTTP Client / Frontend / Swagger UI"])

    subgraph NestJS App ["NestJS Application (Port 3000)"]
        Middleware["Logger Middleware"]
        Guards["JwtAuthGuard / LocalAuthGuard"]
        Validation["ValidationPipe / ParseUUIDPipe"]

        subgraph Controllers ["Controllers"]
            AppCtrl["AppController (Health)"]
            AuthCtrl["AuthController (/auth)"]
            UsersCtrl["UsersController (/users)"]
        end

        subgraph Services ["Services & Logic"]
            AuthSvc["AuthService"]
            UsersSvc["UsersService"]
            S3Svc["S3Service"]
            PrismaSvc["PrismaService"]
        end

        Filters["Prisma & AllExceptions Filter"]
    end

    subgraph Infrastructure ["Local Infrastructure (Docker Compose)"]
        PostgresDB[("PostgreSQL 17 (Port 5435)")]
        MinioStorage[("MinIO S3 Storage (Port 9000/9001)")]
    end

    Client -->|HTTP Request| Middleware
    Middleware --> Guards
    Guards --> Validation
    Validation --> Controllers

    AuthCtrl --> AuthSvc
    UsersCtrl --> UsersSvc
    UsersSvc --> S3Svc
    UsersSvc --> PrismaSvc
    AuthSvc --> PrismaSvc

    PrismaSvc -->|Prisma Client| PostgresDB
    S3Svc -->|AWS SDK v3| MinioStorage
    Controllers -.-> Filters
```

---

## 🛠️ Tech Stack

| Layer                  | Technology                                                       | Description                                |
| :--------------------- | :--------------------------------------------------------------- | :----------------------------------------- |
| **Backend Framework**  | [NestJS 12](https://nestjs.com/)                                 | Progressive Node.js framework (ESM)        |
| **Language**           | [TypeScript 5](https://www.typescriptlang.org/)                  | Strongly-typed JavaScript                  |
| **Database**           | [PostgreSQL 17](https://www.postgresql.org/)                     | Relational database engine                 |
| **ORM**                | [Prisma 7](https://www.prisma.io/)                               | Next-generation Node.js ORM                |
| **Object Storage**     | [MinIO](https://min.io/) / [AWS S3](https://aws.amazon.com/s3/)  | S3-compatible cloud object storage         |
| **Authentication**     | [Passport](https://www.passportjs.org/) + [JWT](https://jwt.io/) | Stateless token-based auth                 |
| **API Documentation**  | [Swagger / OpenAPI 3.0](https://swagger.io/)                     | Auto-generated interactive API docs        |
| **Testing**            | [Vitest](https://vitest.dev/)                                    | Vite-powered unit test runner              |
| **Linter & Formatter** | [Oxlint](https://oxc.rs/) + [Prettier](https://prettier.io/)     | High-performance linter and code formatter |
| **Containers**         | [Docker Compose](https://www.docker.com/)                        | Local containerized services               |

---

## 🚀 Getting Started

### Prerequisites

- **Node.js**: `v20.x` or higher
- **npm**: `v10.x` or higher
- **Docker & Docker Compose**: Installed and running

### 1. Clone & Install Dependencies

```bash
git clone <repository-url>
cd user-management-system
npm install
```

### 2. Environment Configuration

Copy the example environment configuration file:

```bash
cp .env.example .env
```

Verify the default values in `.env`:

```ini
PORT=3000

# PostgreSQL
POSTGRES_USER=postgredb
POSTGRES_PASSWORD=postgredb
POSTGRES_DB=user_management_system
DATABASE_URL="postgresql://postgredb:postgredb@localhost:5435/user_management_system?schema=public"

# JWT
JWT_SECRET=super-secret-key-change-in-production
JWT_EXPIRES_IN=1d

# MinIO / S3
S3_ENDPOINT=http://localhost:9000
S3_REGION=us-east-1
S3_BUCKET=user-avatars
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_FORCE_PATH_STYLE=true
S3_PUBLIC_URL=http://localhost:9000/user-avatars
```

### 3. Start Database & Storage (Docker)

Start the local PostgreSQL and MinIO instances in the background:

```bash
docker compose up -d
```

- **PostgreSQL**: `localhost:5435`
- **MinIO S3 API**: `localhost:9000`
- **MinIO Web Console**: `http://localhost:9001` (User: `minioadmin`, Pass: `minioadmin`)

### 4. Run Database Migrations

Apply the Prisma schema to the database:

```bash
npx prisma db push
```

### 5. Start the Application

```bash
# Development mode with watch:
npm run start:dev

# Production build & run:
npm run build
npm run start:prod
```

Once started, the server will log:

```text
[Nest] ... LOG [Bootstrap] Application is running on: http://localhost:3000
[Nest] ... LOG [Bootstrap] Swagger documentation: http://localhost:3000/api-docs
```

---

## 📖 API Documentation

Interactive Swagger documentation is available out-of-the-box at:

👉 **[http://localhost:3000/api-docs](http://localhost:3000/api-docs)**

Raw OpenAPI JSON specification: `http://localhost:3000/api-docs-json`

### Authentication Flow in Swagger UI:

1. Call `POST /auth/login` with your credentials (`email` and `password`).
2. Copy the returned `access_token`.
3. Click the **Authorize 🔓** button at the top right of Swagger UI.
4. Enter `Bearer <your_token>` and click **Authorize**.
5. All protected endpoints (`/users`, `/users/avatar`, `/auth/me`) are now unlocked for testing.

---

## 🧪 Testing & Code Quality

```bash
# Run type-aware linter (Oxlint)
npm run lint

# Format code with Prettier
npm run format

# Run unit tests (Vitest)
npm test

# Run e2e tests
npm run test:e2e
```

---

## 📂 Project Structure

```text
user-management-system/
├── docker-compose.yml       # Local PostgreSQL 17 & MinIO containers
├── nest-cli.json            # Nest CLI config with Swagger auto-generation plugin
├── package.json             # Scripts & dependencies
├── prisma/
│   └── schema.prisma        # Prisma schema definitions
├── src/
│   ├── app.controller.ts    # Health check endpoint
│   ├── app.module.ts        # Main application module
│   ├── main.ts              # Entrypoint, Swagger & global pipes bootstrap
│   ├── common/              # Shared guards, interceptors, filters, decorators
│   ├── core/                # Core providers: Prisma database, S3 storage, env validation
│   └── modules/
│       ├── auth/            # Auth module (Passport local/jwt, token issuance)
│       └── users/           # Users module (CRUD, avatar upload)
├── AGENTS.md                # Operating guidelines for AI coding assistants
└── GIT_GUIDELINES.md        # Branching, conventional commits & PR standards
```

---

## 🤝 Contribution & Workflow

This project adheres to **Trunk-Based Development** and **Conventional Commits**:

- Refer to [GIT_GUIDELINES.md](file:///d:/VscodeProjects/user-management-system/GIT_GUIDELINES.md) for branch naming (`feat/`, `fix/`, `docs/`) and commit standards.
- Refer to [AGENTS.md](file:///d:/VscodeProjects/user-management-system/AGENTS.md) when developing with AI coding agents.

---

## 📄 License

This project is licensed under the UNLICENSED / MIT License.
