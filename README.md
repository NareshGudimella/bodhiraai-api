# bodhiraai-api

NestJS 11 + Drizzle ORM backend for Bodhira, on its own PostgreSQL database. It serves `/api/v1/*` with the same contract as the legacy Laravel API (`../bodhiraai.com/api.md`).

```bash
cp .env.example .env         # DATABASE_URL (PostgreSQL)
npm install
createdb bodhira             # once
npm run db:migrate           # create the schema
npm run start:dev            # http://localhost:4000/api/v1/ping
npm test && npm run test:e2e
```

See [AGENTS.md](AGENTS.md) for the structure and conventions, [docs/drizzle.md](docs/drizzle.md) for database access, and [../docs/migration-plan.md](../docs/migration-plan.md) for status. Production: [DEPLOY.md](DEPLOY.md).
