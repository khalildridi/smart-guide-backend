# smart-guide-backend

Backend API extracted from smart-guide frontend repo.

## Run

```bash
npm install
npm run dev
```

## Docker

Build and run:

```bash
docker compose up --build -d
```

Logs:

```bash
docker compose logs -f
```

Stop:

```bash
docker compose down
```

## Tests

Smoke API checks:

```bash
npm run smoke:api
```

Critical E2E checks:

```bash
npm run e2e:critical
```

Required env vars for `e2e:critical`:

```env
E2E_USER_EMAIL=
E2E_USER_PASSWORD=
```

Optional overrides:

```env
E2E_BASE_URL=http://localhost:4000
SMOKE_BASE_URL=http://localhost:4000
```
