Vybe Cabs Backend 

Hey! This is a ride-hailing backend project (like Uber/Ola/Rapido) that I build using NestJS, PostgreSQL (TypeORM), and Redis. It has geo based nearest-driver search, WebSocket notifications (simulated), and the most important part - a concurrency safe ride assignment system using Redis distributed locks so no two drivers get assigned to the same ride.


1. Project Overview

Basically Vybe Cabs is the core matching engine of a ride-hailing app:


Rider requests a ride → we find nearest available drivers using Redis GEO and notify them.
If multiple drivers try to accept the same ride at the same time → only one should get it, no race conditions. This is done using Redis distributed lock + atomic NX write.
If no driver accepts within 15 seconds, ride times out and retrys with next nearest batch of drivers.
Every notification/accept/reject gets logged so we have a full audit trail for RCA (root cause analysis).


Check architecture.md for the full diagram and how the concurrency thing works in detail.


2. Folder Structure

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


3. Installation

bashgit clone <your-repo-url> vybe-cabs-backend
cd vybe-cabs-backend
npm install

4. Environment Variables

Copy .env.example to .env (already added as .env for local dev, so u don't have to do anything extra for now):

envPORT=3000

DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=
DB_PASSWORD=
DB_DATABASE=vybe_cabs

REDIS_HOST=localhost
REDIS_PORT=6379

RIDE_ACCEPT_TIMEOUT_SECONDS=15
NEAREST_DRIVER_SEARCH_RADIUS_KM=5
NEAREST_DRIVER_BATCH_SIZE=5

5. Database Setup

You need PostgreSQL running locally (or use Docker, mentioned below).

bash# Create the database (skip this if you're using Docker)
createdb -U postgres vybe_cabs

synchronize: true is turned on in src/config/typeorm.config.ts, so all tables (drivers, rides, ride_assignment_logs) get auto created when app starts first time. No need to run migrations manually for local dev.

6. Redis Setup

Need Redis running locally too (or Docker):

bashredis-server

7. Run

bash# Development (watch mode)
npm run start:dev

# Production build
npm run build
npm run start:prod

App runs on http://localhost:3000.
Swagger docs: http://localhost:3000/api/docs

8. Docker

If you wanna run Postgres + Redis + the app all together:

bashdocker compose up --build

This will start:


postgres on 5432
redis on 6379
app (NestJS) on 3000


9. API List

MethodEndpointDescriptionPOST/driversRegister a driverPATCH/drivers/locationUpdate driver's live GPS locationGET/driversList all driversGET/drivers/:idGet a driverPOST/ridesRequest a ride (kicks off search + notify)GET/ridesList all ridesGET/rides/:idGet a ridePOST/rides/:id/acceptDriver accepts a ride (concurrency-safe)PATCH/rides/:id/completeMark ride completed, free driver

Full request/response schema's are in Swagger (/api/docs).

10. Postman

Import Vybe.postman_collection.json into Postman. It has a baseUrl variable (default http://localhost:3000) plus driverId/rideId variables that you can fill from earlier responses.

11. Concurrency Strategy

Full detail is in architecture.md. Short version:


Redis distributed lock (SET key NX PX 5000) per ride — only one caller can proceed at a time for a ride, everyone else gets 409 Conflict immediately.
Atomic NX assignment key (ride:assignment:{rideId}) written inside the lock — this is the actual single-writer guarantee, works even without the lock.
Idempotency — if the same driver clicks accept multiple times, it just returns success instead of throwing error.
Late acceptance rejection — a driver can only accept while they're part of the ride's current notification wave (RideService.activeWaveDrivers). As soon as a wave's 15s window is up, its drivers get removed from that set (see handleTimeout), so any accept coming after that gets rejected with 410 Gone, even if a new wave hasn't started yet.
Safe lock release — a Lua script checks the token owner before deleting the lock, so a slow caller can never accidentally delete someone else's lock.


12. Redis GEO Explanation


GEOADD drivers:geo <lon> <lat> <driverId> saves/updates every driver's live location in a single sorted-set based geo index.
GEOSEARCH drivers:geo FROMLONLAT <lon> <lat> BYRADIUS <km> ASC COUNT <n> WITHDIST gives back nearest drivers to a pickup point, sorted by distance, in O(log(N)+M) time — way faster than doing a haversine query in Postgres at scale.
Availability is tracked separately in a Redis Set (drivers:available) so unavailable drivers get filtered out of search without needing to remove/re-add them from the GEO index (removing would loose their location for next time).


13. Distributed Lock Explanation

This is implemented in RedisService.acquireLock / releaseLock using the standard single node lock pattern:

SET lock:ride:{rideId} <uuid-token> NX PX 5000


NX → only succeeds if lock doesn't already exist (atomic test-and-set).
PX 5000 → auto expires after 5s, so if a process crashes it can't deadlock the ride forever.
Release uses a Lua script (GET then conditional DEL) so the caller only deletes a lock it still owns — otherwise a slow request could accidently delete a lock that some other, later request acquired.


14. Timeout Flow

RideService.armTimeout schedules a 15s setTimeout per ride after every notification wave. If it fires before someone accepts, handleTimeout runs — audit logs get updated, ride status goes to TIMEOUT, and timeout gets cleared as soon as any accept succeeds (clearTimeoutFor).

15. Retry Flow

When a timeout happens, searchAndNotify runs again automatically, excluding every driver already notified for this ride (we keep track in an in-memory Set per ride), so next wave reaches genuinely new nearest drivers.

16. Testing

bashnpm run test          # unit tests (Jest) — includes concurrency race test with mocked Redis
npm run test:cov       # with coverage

src/modules/ride/ride.service.spec.ts proves (with mocked but realistic Redis behaviour) that two simultaneous acceptRide() calls give exactly one success and one GoneException, and repeat accepts from same driver are idempotent.

Live end-to-end concurrency simulation

With the app running (npm run start:dev, plus Postgres/Redis up):

bashnpm run simulate:concurrency

This registers 100 real drivers at the exact pickup coordinates (so whichever subset Redis actually notifies is guranteed to come from this pool), creates a ride, then fires 100 parallel POST /rides/:id/accept calls - one per driver - against the real HTTP server, and prints:

Successful Driver: <uuid>
Rejected Drivers: 99
Execution Time: <ms>

Only one driver wins the race, rest get rejected either by the lock/atomic-assignment check (drivers who were notified but lost) or by the late-acceptance check (drivers who were never part of the notified wave - this is realistic with default NEAREST_DRIVER_BATCH_SIZE=5). If you want to see all 100 actually get notified in one wave, start server with NEAREST_DRIVER_BATCH_SIZE=100.

17. Performance


Redis GEOSEARCH and lock operations are O(log N) / O(1) so nearest-driver search and assignment stays fast even with tens of thousands of active drivers.
The distributed lock's 5s TTL limits worst case lock contention; 409 responses are cheap fail-fast rejections instead of blocking waits, so 100 concurrent accepts resolve in low tens of milliseconds against a local Redis.


18. Future Improvements


Replace single node Redis lock with proper Redlock (multi-node quorum) for HA deployments.
Move synchronize: true to versioned TypeORM migrations before any real production rollout.
Expand search radius progressively when a wave finds zero candidates, instead of a static radius.
Add authentication/authorization (JWT + role guards) — was explicitly out of scope for this assignment.
Persist WebSocket delivery receipts so we definitely know if a driver's device recieved the push.
Add integration tests against real Testcontainers managed Postgres/Redis instances.
