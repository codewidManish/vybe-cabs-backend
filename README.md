# Vybe Cabs Backend 🚕

A production-grade, ride-hailing backend (Uber/Ola/Rapido-style) built with **NestJS**, **PostgreSQL (TypeORM)**, and **Redis** — featuring geo-based nearest-driver search, WebSocket-simulated notifications, and a fully concurrency-safe ride-assignment engine backed by Redis distributed locks and atomic operations.

---

## 1. Project Overview

Vybe Cabs models the core matching engine of a ride-hailing platform:

- Riders request a ride → nearest available drivers are found via **Redis GEO** and notified.
- Multiple drivers may try to accept simultaneously → the system guarantees **exactly one** assignment, with zero race conditions, using a **Redis distributed lock** + **atomic NX write**.
- If nobody accepts within 15 seconds, the ride **times out and retries** with the next-nearest batch.
- Full audit trail of every notification/accept/reject is persisted for RCA.

See [`architecture.md`](./architecture.md) for the full flow diagram and concurrency design rationale.

---

## 2. Folder Structure

```
vybe-cabs-backend/
├── src/
│   ├── modules/
│   │   ├── driver/           # Driver entity, DTOs, service, controller
│   │   ├── ride/              # Ride + RideAssignmentLog entities, matching engine
│   │   ├── redis/             # GEO, distributed lock, atomic assignment
│   │   └── notification/      # WebSocket gateway + notification service
│   ├── common/
│   │   ├── enums/              # RideStatus, AssignmentLogStatus
│   │   ├── filters/            # GlobalExceptionFilter
│   │   └── interceptors/       # LoggingInterceptor
│   ├── config/                 # typeorm.config.ts, redis.config.ts
│   ├── app.module.ts
│   └── main.ts
├── test/
│   └── simulate-concurrency.ts # 100-driver race simulation script
├── Dockerfile
├── docker-compose.yml
├── Vybe.postman_collection.json
├── architecture.md
└── .env
```

---

## 3. Installation

```bash
git clone <your-repo-url> vybe-cabs-backend
cd vybe-cabs-backend
npm install
```

## 4. Environment Variables

Copy `.env.example` to `.env` (already provided as `.env` for local dev):

```env
PORT=3000

DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=root123
DB_DATABASE=vybe_cabs

REDIS_HOST=localhost
REDIS_PORT=6379

RIDE_ACCEPT_TIMEOUT_SECONDS=15
NEAREST_DRIVER_SEARCH_RADIUS_KM=5
NEAREST_DRIVER_BATCH_SIZE=5
```

## 5. Database Setup

Requires PostgreSQL running locally (or via Docker, see below).

```bash
# Create the database (if not using Docker)
createdb -U postgres vybe_cabs
```

`synchronize: true` is enabled in `src/config/typeorm.config.ts`, so tables (`drivers`, `rides`, `ride_assignment_logs`) are auto-created on first boot. No manual migration needed for local dev.

## 6. Redis Setup

Requires Redis running locally (or via Docker):

```bash
redis-server
```

## 7. Run

```bash
# Development (watch mode)
npm run start:dev

# Production build
npm run build
npm run start:prod
```

App runs at `http://localhost:3000`.
Swagger docs: `http://localhost:3000/api/docs`

## 8. Docker

Spin up Postgres + Redis + the app together:

```bash
docker compose up --build
```

This starts:
- `postgres` on `5432`
- `redis` on `6379`
- `app` (NestJS) on `3000`

## 9. API List

| Method | Endpoint | Description |
|---|---|---|
| POST | `/drivers` | Register a driver |
| PATCH | `/drivers/location` | Update driver's live GPS location |
| GET | `/drivers` | List all drivers |
| GET | `/drivers/:id` | Get a driver |
| POST | `/rides` | Request a ride (kicks off search + notify) |
| GET | `/rides` | List all rides |
| GET | `/rides/:id` | Get a ride |
| POST | `/rides/:id/accept` | Driver accepts a ride (concurrency-safe) |
| PATCH | `/rides/:id/complete` | Mark ride completed, free driver |

Full request/response schemas are in Swagger (`/api/docs`).

## 10. Postman

Import [`Vybe.postman_collection.json`](./Vybe.postman_collection.json) into Postman. It includes a `baseUrl` variable (defaults to `http://localhost:3000`) plus `driverId`/`rideId` variables you can populate from earlier responses.

## 11. Concurrency Strategy

See [`architecture.md`](./architecture.md#concurrency-model-the-critical-path) for full detail. Summary:

1. **Redis distributed lock** (`SET key NX PX 5000`) scoped per ride — only one caller proceeds per ride at a time; others get `409 Conflict` immediately.
2. **Atomic NX assignment key** (`ride:assignment:{rideId}`) written inside the lock — the actual single-writer guarantee, safe even without the lock.
3. **Idempotency** — the same driver re-accepting is detected and short-circuited to a success instead of an error.
4. **Late acceptance rejection** — a driver may only accept while they belong to the ride's *current* notification wave (`RideService.activeWaveDrivers`). The instant a wave's 15s window expires, its drivers are evicted from that set (see `handleTimeout`), so any accept arriving after that point is rejected with `410 Gone`, even if no new wave has started yet.
5. **Safe lock release** — a Lua script checks token ownership before deleting, so a slow caller can never release a lock it no longer owns.

## 12. Redis GEO Explanation

- `GEOADD drivers:geo <lon> <lat> <driverId>` stores/updates every driver's live position in a single sorted-set-backed geo index.
- `GEOSEARCH drivers:geo FROMLONLAT <lon> <lat> BYRADIUS <km> ASC COUNT <n> WITHDIST` returns the nearest drivers to a pickup point, sorted by distance, in O(log(N)+M) — far faster than a Postgres haversine query at scale.
- Availability is tracked in a parallel Redis Set (`drivers:available`) so unavailable drivers are filtered out of search results without needing to remove/re-add them from the GEO index (removal would lose their location on the next request).

## 13. Distributed Lock Explanation

Implemented in `RedisService.acquireLock` / `releaseLock` using the standard single-node lock pattern:

```
SET lock:ride:{rideId} <uuid-token> NX PX 5000
```

- `NX` → only succeeds if no lock currently exists (atomic test-and-set).
- `PX 5000` → auto-expires after 5s, so a crashed process can never deadlock the ride forever.
- Release uses a Lua script (`GET` then conditional `DEL`) to guarantee the caller only deletes a lock it still owns — otherwise a slow request could delete a lock acquired by a different, later request.

## 14. Timeout Flow

`RideService.armTimeout` schedules a 15s `setTimeout` per ride after each notification wave. If it fires before an accept succeeds, `handleTimeout` runs: audit logs are updated, ride status flips to `TIMEOUT`, and the timeout is cleared as soon as any accept succeeds (`clearTimeoutFor`).

## 15. Retry Flow

On timeout, `searchAndNotify` re-runs automatically, excluding every driver already notified for this ride (tracked in an in-memory `Set` per ride), so the next wave reaches genuinely new nearest candidates.

## 16. Testing

```bash
npm run test          # unit tests (Jest) — includes concurrency race test with mocked Redis
npm run test:cov       # with coverage
```

`src/modules/ride/ride.service.spec.ts` proves, with mocked but semantically-accurate Redis behavior, that two simultaneous `acceptRide()` calls yield exactly one success and one `GoneException`, and that repeat-accepts from the same driver are idempotent.

### Live end-to-end concurrency simulation

With the app running (`npm run start:dev`, plus Postgres/Redis up):

```bash
npm run simulate:concurrency
```

This registers **100 real drivers** at the exact pickup coordinates (so whichever subset Redis genuinely notifies is guaranteed to come from this pool), creates a ride, then fires **100 parallel** `POST /rides/:id/accept` calls — one per driver — against the real HTTP server, and prints:

```
Successful Driver: <uuid>
Rejected Drivers: 99
Execution Time: <ms>
```

Exactly one driver wins the race; the rest are rejected either by the lock/atomic-assignment check (drivers who *were* notified but lost) or by the late-acceptance check (drivers who were never part of the notified wave — realistic with the default `NEAREST_DRIVER_BATCH_SIZE=5`). To watch all 100 genuinely notified in one wave, start the server with `NEAREST_DRIVER_BATCH_SIZE=100`.

## 17. Performance

- Redis GEOSEARCH and lock operations are O(log N) / O(1) — nearest-driver search and assignment stay fast even with tens of thousands of active drivers.
- The distributed lock's 5s TTL bounds worst-case lock contention; `409` responses are cheap fail-fast rejections rather than blocking waits, so 100 concurrent accepts resolve in low tens of milliseconds against a local Redis instance.

## 18. Future Improvements

- Replace single-node Redis lock with full **Redlock** (multi-node quorum) for HA deployments.
- Move `synchronize: true` to versioned TypeORM migrations before any real production rollout.
- Expand search radius progressively when a wave finds zero candidates instead of a static radius.
- Add authentication/authorization (JWT + role guards) — explicitly out of scope for this assignment.
- Persist WebSocket delivery receipts to know definitively whether a driver's device received the push.
- Add integration tests against real Testcontainers-managed Postgres/Redis instances.

---

## License

MIT
