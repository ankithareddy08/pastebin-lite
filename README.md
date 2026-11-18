# Pastebin Lite

A small text-sharing app built for the Pastebin-Lite take-home assignment. Create a paste, share its link, and optionally limit its lifetime or number of views. The frontend uses plain HTML, CSS, and JavaScript; the backend uses Node.js 24. No third-party runtime packages or frontend compilation are needed.

## Run locally

Install Node.js **24.x**, then run these commands from the repository root:

```sh
npm ci
npm start
```

Open the **Local** address printed in the terminal. The default port is `3000`. `npm run dev` restarts the server when source files change.

SQLite works immediately without account setup. The app creates `data/pastes.sqlite` and its schema automatically. Stopping and restarting the server preserves pastes and their remaining views. Node 24 versions that mark `node:sqlite` experimental may print a warning; this does not prevent the app from running.

Optional configuration: copy `.env.example` to `.env` and edit it. The local server loads `.env`; existing environment variables take precedence. Do not commit `.env` or database files.

## Commands

| Command | Purpose |
| --- | --- |
| `npm start` | Start the application |
| `npm run dev` | Start with Node's source-file watcher |
| `npm run build` | Check JavaScript syntax, configuration, and required files; no bundle is needed |
| `npm test` | Run automated tests using temporary databases |
| `npm run check` | Run the build check and tests |

## Persistence

- **Local / persistent disk:** SQLite through Node's built-in `node:sqlite`. A single conditional `UPDATE ... RETURNING` checks eligibility and consumes one view. SQLite serializes writes even across multiple app processes sharing the same database file. The schema is created automatically on startup.
- **Vercel / serverless:** Upstash Redis over HTTPS. One Lua script checks expiry and the remaining count, decrements the count, and returns the text atomically. All instances share the same database. Creation is conditional to avoid overwriting an existing ID. No migrations or shell access are needed.

The app refuses to use local SQLite in Vercel. Serverless filesystems are not a durable shared database. There is no in-memory paste store or process-local view counter.

Expiry is stored as an absolute millisecond timestamp, rather than relying on Redis's real-time TTL. This lets the assignment's fake clock work consistently. Redis removes expired or exhausted records when accessed. SQLite permanently marks an observed expiry as exhausted, so moving the test clock backwards cannot revive it. Expiry means the paste becomes inaccessible; this app does not promise immediate physical deletion of all expired records. Unaccessed records can remain stored, and SQLite retains its rows. A larger production service should add a separate retention cleanup policy.

## Environment variables

| Variable | Default / use |
| --- | --- |
| `PORT` | `3000` locally |
| `HOST` | `127.0.0.1` locally; set `0.0.0.0` for container hosting |
| `STORAGE_DRIVER` | `sqlite` locally; `redis` when Redis credentials are present or on Vercel |
| `DATABASE_PATH` | `./data/pastes.sqlite`; SQLite only |
| `UPSTASH_REDIS_REST_URL` | Redis HTTPS REST endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | Redis read/write REST token; server-only secret |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Supported aliases for Vercel Redis integrations |
| `TEST_MODE` | Only the exact value `1` enables the test clock |
| `APP_BASE_URL` | Optional canonical public origin; otherwise derived from the incoming request |
| `TRUST_PROXY` | Set to `1` only behind a trusted reverse proxy; automatically enabled in the Vercel handler |

Use a dedicated Redis database for this application. Do not configure a read-only token.

## Deploy to Vercel

1. Push the source code and lockfile to a **public Git repository**.
2. Create an Upstash Redis database (directly or through Vercel's integration). Copy its REST URL and read/write token into the Vercel project's environment settings.
3. Import the repository into Vercel. Use Node.js `24.x` and the **Other** framework preset. The included `vercel.json` sets `npm run build`, serves `public/`, and routes `/api/*` and `/p/*` to the shared Node function.
4. Set `STORAGE_DRIVER=redis`, `UPSTASH_REDIS_REST_URL`, and `UPSTASH_REDIS_REST_TOKEN` for the target environment. The `KV_REST_API_*` aliases also work. Do not copy the example's SQLite settings to Vercel.
5. Set **`TEST_MODE=1` on the assessment deployment** so the grader can test expiry. Omit it or set `0` for ordinary production use.
6. Deploy. No manual database migration is required. Make sure the submitted production URL is accessible to the grader without a Vercel login/protection screen.
7. Check `/api/healthz` returns `200` with `{"ok":true}`, create a paste, and open its returned link. Check a one-view paste is unavailable on a second read.

Share the deployed URL, public repository URL, and the persistence/design notes in this README. A working local build alone is not the complete submission.

Alternatively, deploy the Node server to a host with a persistent volume and set `DATABASE_PATH` to that volume. Do not use SQLite on an ephemeral disk or across separate machines.

## HTTP contract

| Method and path | Result |
| --- | --- |
| `GET /api/healthz` | `200`, JSON `{"ok":true}` when persistence is reachable. Returns `{"ok":false}` with `200` if it is not, preserving the assignment's health-check status contract. |
| `POST /api/pastes` | JSON body with required non-empty string `content`, optional integer `ttl_seconds >= 1`, optional integer `max_views >= 1`. Returns `201` with `id` and an absolute `url` ending in `/p/:id`. |
| `GET /api/pastes/:id` | `200` JSON with `content`, `remaining_views` (after this read, or `null`), and `expires_at` (ISO timestamp, or `null`). Consumes one view. |
| `GET /p/:id` | Safely escaped, server-rendered HTML containing the paste. Consumes one view. |

Invalid input returns a `4xx` JSON error. Missing, expired, and exhausted pastes return `404` (JSON from the API, HTML from the webpage). Storage failures return `503` without disclosing credentials. Unsupported methods return `405`. Paste routes reject `HEAD` without consuming views.

### Example

Send this JSON to `POST /api/pastes` with `Content-Type: application/json`:

```json
{
  "content": "A note worth sharing.",
  "ttl_seconds": 60,
  "max_views": 2
}
```

The first successful API read reports `remaining_views: 1`, the second reports `0`, and the third returns `404`. If 60 seconds pass first, reads return `404` even if views remain.

### Deterministic time

With `TEST_MODE=1`, the request header `x-test-now-ms` supplies the current time **for expiry only**, on both creation and reads. Without that header, real system time is used. Outside test mode, the header is ignored. Invalid test timestamps return `400`. Expiry is inclusive: `now >= expires_at` is unavailable.

For example, create a 60-second paste with `x-test-now-ms: 2000000000000`. It expires at `2000000060000`. A read with `2000000059999` succeeds; a read with `2000000060000` returns `404`.

## Notable decisions

- Both API and webpage GETs consume one view from the same counter. The PDF explicitly counts API reads; counting webpage reads too makes the user-visible view limit consistent. Copying text, creating a paste, and loading static assets consume no additional views. The viewer never refetches the paste in browser JavaScript.
- Return the final allowed view successfully with `remaining_views: 0`; only later requests are unavailable.
- Content is preserved without trimming, including whitespace-only strings. HTML metacharacters are escaped, and a restrictive Content Security Policy adds protection against scripts.
- Random 144-bit IDs avoid guessable sequential identifiers. There is no login system: anyone who has a link can read an available paste.
- Responses are not cached, so caches cannot replay a limited paste after its last view. Browser history can still contain previously viewed information; view limits cannot revoke a copy someone already received.
- The API accepts JSON bodies up to 1 MiB. Numeric limits must be positive safe integers, and TTL must produce a representable date. Network/database failures are not automatically retried when a retry could consume another view.
- No hardcoded development origin: share links use the request's origin, trusted Vercel forwarding headers, or `APP_BASE_URL` if explicitly configured.

## Project layout

```text
api/index.mjs          Vercel function adapter
public/               Browser interface, styles, and copy behavior
src/app.mjs           HTTP routes and responses
src/server.mjs        Local Node server
src/validation.mjs    Input, expiry clock, and origin validation
src/views.mjs         Safe server-rendered paste/error pages
src/store/            SQLite and Redis persistence adapters
tests/                API, concurrency, persistence, and storage tests
scripts/check.mjs     Build/readiness check
```

Tests use real HTTP requests to isolated local servers, including two independent processes sharing one SQLite file. They cover the assignment's creation, retrieval, limits, clock, error handling, and persistence requirements. Redis transport tests run without credentials. To run the optional live Redis test, set `REDIS_INTEGRATION=1` plus `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` in the terminal environment before `npm test` (the test runner does not load `.env`). Use a disposable database. Live tests use random namespaced keys and clean up after themselves.
