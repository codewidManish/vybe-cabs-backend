import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { getRedisConfig } from '../../config/redis.config';

export interface NearbyDriver {
  driverId: string;
  distanceKm: number;
}

/**
 * Central Redis access layer. Encapsulates:
 *  1. Driver GEO storage (GEOADD / GEOSEARCH) for live location + nearest-driver queries.
 *  2. Driver availability flags.
 *  3. A distributed lock (SET NX PX) used to make ride assignment atomic across
 *     concurrent driver "accept" requests hitting different app instances.
 *  4. A Lua script that combines "check lock owner + release" atomically (safe unlock),
 *     and a second script that performs "assign-if-unassigned" as a single atomic op.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis;

  private static readonly GEO_KEY = 'drivers:geo';
  private static readonly AVAILABLE_SET = 'drivers:available';
  private static readonly ASSIGNMENT_PREFIX = 'ride:assignment:'; // ride:assignment:{rideId} -> driverId (once set, ride is locked-in)
  private static readonly LOCK_PREFIX = 'lock:ride:'; // lock:ride:{rideId}

  onModuleInit() {
    const { host, port } = getRedisConfig();
    this.client = new Redis({ host, port });
    this.client.on('connect', () => this.logger.log(`Connected to Redis at ${host}:${port}`));
    this.client.on('error', (err) => this.logger.error(`Redis error: ${err.message}`));
  }

  onModuleDestroy() {
    this.client?.disconnect();
  }

  getClient(): Redis {
    return this.client;
  }

  // ---------------------------------------------------------------------
  // Driver GEO location
  // ---------------------------------------------------------------------

  /** Stores/updates a driver's live coordinates in the Redis GEO index. */
  async updateDriverLocation(driverId: string, longitude: number, latitude: number): Promise<void> {
    await this.client.geoadd(RedisService.GEO_KEY, longitude, latitude, driverId);
  }

  /** Removes a driver entirely from the GEO index (e.g. driver goes offline permanently). */
  async removeDriverLocation(driverId: string): Promise<void> {
    await this.client.zrem(RedisService.GEO_KEY, driverId);
  }

  /**
   * Finds nearest AVAILABLE drivers to a pickup point using GEOSEARCH,
   * sorted ascending by distance, capped to `count`, within `radiusKm`.
   * Excludes any driverId present in `excludeIds` (already-notified/rejected drivers).
   */
  async findNearestAvailableDrivers(
    longitude: number,
    latitude: number,
    radiusKm: number,
    count: number,
    excludeIds: string[] = [],
  ): Promise<NearbyDriver[]> {
    // GEOSEARCH returns [member, distance] pairs sorted by ASC distance.
    const raw = (await this.client.geosearch(
      RedisService.GEO_KEY,
      'FROMLONLAT',
      longitude,
      latitude,
      'BYRADIUS',
      radiusKm,
      'km',
      'ASC',
      'COUNT',
      count + excludeIds.length, // over-fetch to account for post-filtering
      'WITHCOORD',
      'WITHDIST',
    )) as any[];

    const excludeSet = new Set(excludeIds);
    const candidates: NearbyDriver[] = [];

    for (const entry of raw) {
      const driverId = entry[0] as string;
      const distanceKm = parseFloat(entry[1]);
      if (excludeSet.has(driverId)) continue;

      const isAvailable = await this.client.sismember(RedisService.AVAILABLE_SET, driverId);
      if (!isAvailable) continue;

      candidates.push({ driverId, distanceKm });
      if (candidates.length >= count) break;
    }

    return candidates;
  }

  // ---------------------------------------------------------------------
  // Driver availability
  // ---------------------------------------------------------------------

  async markDriverAvailable(driverId: string): Promise<void> {
    await this.client.sadd(RedisService.AVAILABLE_SET, driverId);
  }

  async markDriverUnavailable(driverId: string): Promise<void> {
    await this.client.srem(RedisService.AVAILABLE_SET, driverId);
  }

  async isDriverAvailable(driverId: string): Promise<boolean> {
    const res = await this.client.sismember(RedisService.AVAILABLE_SET, driverId);
    return res === 1;
  }

  // ---------------------------------------------------------------------
  // Distributed lock (SETNX + PX expiry) — classic Redlock-style single-node lock
  // ---------------------------------------------------------------------

  /**
   * Attempts to acquire an exclusive lock for a given key.
   * Uses `SET key value NX PX ttlMs` — atomic at the Redis level, so two
   * concurrent callers can never both succeed. Returns a unique lock token
   * (used later to safely release only-if-owner) or null if lock is already held.
   */
  async acquireLock(key: string, ttlMs = 5000): Promise<string | null> {
    const token = randomUUID();
    const result = await this.client.set(`${RedisService.LOCK_PREFIX}${key}`, token, 'PX', ttlMs, 'NX');
    return result === 'OK' ? token : null;
  }

  /**
   * Releases a lock ONLY if the caller still owns it (token matches).
   * Implemented as a Lua script so the "check + delete" is atomic — prevents
   * a slow caller from accidentally deleting a lock re-acquired by someone else
   * after its own lock expired.
   */
  async releaseLock(key: string, token: string): Promise<boolean> {
    const script = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      else
        return 0
      end
    `;
    const result = await this.client.eval(script, 1, `${RedisService.LOCK_PREFIX}${key}`, token);
    return result === 1;
  }

  // ---------------------------------------------------------------------
  // Atomic ride assignment (idempotency + race-condition prevention)
  // ---------------------------------------------------------------------

  /**
   * Atomically assigns a ride to a driver IF AND ONLY IF the ride has no
   * assignment yet. This is the ultimate source of truth for "who won" among
   * concurrently accepting drivers — implemented via SET NX so it's atomic
   * even without the outer lock, giving defense-in-depth.
   *
   * Returns true if THIS call performed the assignment, false if the ride
   * was already assigned to someone (possibly this same driver — idempotency).
   */
  async tryAssignRideAtomically(rideId: string, driverId: string): Promise<boolean> {
    const key = `${RedisService.ASSIGNMENT_PREFIX}${rideId}`;
    // NX ensures only the first writer wins; no TTL — assignment is permanent
    // for the lifetime of the ride (cleared on completion/cancellation if desired).
    const result = await this.client.set(key, driverId, 'NX');
    return result === 'OK';
  }

  async getRideAssignment(rideId: string): Promise<string | null> {
    return this.client.get(`${RedisService.ASSIGNMENT_PREFIX}${rideId}`);
  }

  async clearRideAssignment(rideId: string): Promise<void> {
    await this.client.del(`${RedisService.ASSIGNMENT_PREFIX}${rideId}`);
  }
}
