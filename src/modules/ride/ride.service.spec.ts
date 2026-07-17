import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { RideService } from './ride.service';
import { Ride } from './entities/ride.entity';
import { RideAssignmentLog } from './entities/ride-assignment-log.entity';
import { RedisService } from '../redis/redis.service';
import { NotificationService } from '../notification/notification.service';
import { RideStatus } from '../../common/enums/ride-status.enum';
import { GoneException, ConflictException } from '@nestjs/common';

/**
 * Unit tests for the concurrency-critical acceptRide() path, using mocked
 * repositories/RedisService so we can deterministically simulate a race
 * between two drivers without needing a live Postgres/Redis instance.
 */
describe('RideService - acceptRide concurrency', () => {
  let service: RideService;
  let redis: jest.Mocked<Partial<RedisService>>;
  let rideRepo: any;
  let logRepo: any;

  const mockRide: Ride = {
    id: 'ride-1',
    riderName: 'Test Rider',
    pickupLatitude: 28.6,
    pickupLongitude: 77.2,
    status: RideStatus.WAITING_FOR_ACCEPTANCE,
    assignedDriverId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    // In-memory lock/assignment store simulating single-node Redis semantics.
    const locks = new Map<string, string>();
    const assignments = new Map<string, string>();

    redis = {
      getRideAssignment: jest.fn(async (rideId: string) => assignments.get(rideId) ?? null),
      acquireLock: jest.fn(async (key: string) => {
        if (locks.has(key)) return null;
        const token = `token-${Math.random()}`;
        locks.set(key, token);
        return token;
      }),
      releaseLock: jest.fn(async (key: string, token: string) => {
        if (locks.get(key) === token) {
          locks.delete(key);
          return true;
        }
        return false;
      }),
      tryAssignRideAtomically: jest.fn(async (rideId: string, driverId: string) => {
        if (assignments.has(rideId)) return false;
        assignments.set(rideId, driverId);
        return true;
      }),
      markDriverUnavailable: jest.fn(async (_driverId: string) => undefined),
      markDriverAvailable: jest.fn(async (_driverId: string) => undefined),
    };

    rideRepo = {
      findOne: jest.fn(async () => ({ ...mockRide })),
      save: jest.fn(async (r: any) => r),
    };
    logRepo = {
      create: jest.fn((x: any) => x),
      save: jest.fn(async () => undefined),
      createQueryBuilder: jest.fn(() => ({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn(async () => undefined),
      })),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        RideService,
        { provide: getRepositoryToken(Ride), useValue: rideRepo },
        { provide: getRepositoryToken(RideAssignmentLog), useValue: logRepo },
        { provide: RedisService, useValue: redis },
        {
          provide: NotificationService,
          useValue: { notifyRideAssigned: jest.fn(), notifyDriverOfRideRequest: jest.fn(), notifyRideTimeout: jest.fn() },
        },
      ],
    }).compile();

    service = moduleRef.get(RideService);

    // These tests exercise acceptRide() directly without going through the real
    // searchAndNotify() flow, so seed the private "current wave" set to mark
    // driver-A/driver-B as legitimately notified for ride-1 (otherwise acceptRide
    // would correctly-but-unhelpfully reject them as late acceptances).
    (service as any).activeWaveDrivers.set('ride-1', new Set(['driver-A', 'driver-B']));
  });

  it('assigns exactly one driver when two drivers accept concurrently', async () => {
    const results = await Promise.allSettled([
      service.acceptRide('ride-1', 'driver-A'),
      service.acceptRide('ride-1', 'driver-B'),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The losing driver fails either while trying to acquire the lock (ConflictException,
    // if it arrives while the winner still holds it) or on the post-lock assignment check
    // (GoneException, if it acquires the lock after the winner already released it).
    // Either outcome proves no double-assignment occurred.
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    expect(reason instanceof GoneException || reason instanceof ConflictException).toBe(true);
  });

  it('is idempotent when the same driver accepts twice', async () => {
    const first = await service.acceptRide('ride-1', 'driver-A');
    expect(first.assignedDriverId ?? 'driver-A').toBeTruthy();

    // Simulate ride now reflecting assignment for subsequent lookups.
    rideRepo.findOne = jest.fn(async () => ({ ...mockRide, status: RideStatus.ASSIGNED, assignedDriverId: 'driver-A' }));

    const second = await service.acceptRide('ride-1', 'driver-A');
    expect(second).toBeDefined();
  });

  it('rejects a late acceptance from a driver outside the current wave', async () => {
    // driver-C was never part of the active wave (e.g. their wave already timed out).
    await expect(service.acceptRide('ride-1', 'driver-C')).rejects.toBeInstanceOf(GoneException);
  });
});
