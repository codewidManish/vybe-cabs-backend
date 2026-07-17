import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Ride } from './entities/ride.entity';
import { RideAssignmentLog } from './entities/ride-assignment-log.entity';
import { CreateRideDto } from './dto/create-ride.dto';
import { RideStatus } from '../../common/enums/ride-status.enum';
import { AssignmentLogStatus } from '../../common/enums/assignment-log-status.enum';
import { RedisService } from '../redis/redis.service';
import { NotificationService } from '../notification/notification.service';

const ACCEPT_TIMEOUT_SECONDS = parseInt(process.env.RIDE_ACCEPT_TIMEOUT_SECONDS || '15', 10);
const SEARCH_RADIUS_KM = parseFloat(process.env.NEAREST_DRIVER_SEARCH_RADIUS_KM || '5');
const BATCH_SIZE = parseInt(process.env.NEAREST_DRIVER_BATCH_SIZE || '5', 10);

@Injectable()
export class RideService {
  private readonly logger = new Logger(RideService.name);

  // In-memory registry of pending timeout timers, keyed by rideId.
  // Lets us cancel the timeout as soon as a ride gets assigned.
  private readonly timeoutHandles = new Map<string, NodeJS.Timeout>();

  // Tracks which drivers have already been notified/excluded for a ride,
  // so retries after a timeout search fresh candidates instead of re-notifying the same set.
  private readonly notifiedDrivers = new Map<string, Set<string>>();

  // Tracks ONLY the drivers notified in the CURRENT (most recent) wave for a ride.
  // This is what enforces "late acceptance": once a wave times out, its drivers
  // are removed from this set, so an accept() from them is rejected even though
  // they're still (permanently) excluded from future waves via notifiedDrivers above.
  private readonly activeWaveDrivers = new Map<string, Set<string>>();


  constructor(
    @InjectRepository(Ride) private readonly rideRepo: Repository<Ride>,
    @InjectRepository(RideAssignmentLog)
    private readonly logRepo: Repository<RideAssignmentLog>,
    private readonly redisService: RedisService,
    private readonly notificationService: NotificationService,
  ) {}

  // ---------------------------------------------------------------------
  // Ride creation + search kickoff
  // ---------------------------------------------------------------------

  async createRide(dto: CreateRideDto): Promise<Ride> {
    const ride = this.rideRepo.create({
      riderName: dto.riderName,
      pickupLatitude: dto.pickupLatitude,
      pickupLongitude: dto.pickupLongitude,
      status: RideStatus.REQUESTED,
      assignedDriverId: null,
    });
    const saved = await this.rideRepo.save(ride);
    this.notifiedDrivers.set(saved.id, new Set());

    this.logger.log(`Ride requested: ${saved.id} for rider ${saved.riderName}`);

    // Fire-and-forget: search + notify happens asynchronously so the API
    // responds immediately with the created ride.
    this.searchAndNotify(saved.id).catch((err) =>
      this.logger.error(`searchAndNotify failed for ride ${saved.id}: ${err.message}`),
    );

    return saved;
  }

  /**
   * Core matching loop for a single "wave":
   *  1. Move ride to SEARCHING.
   *  2. GEOSEARCH Redis for nearest available drivers not yet notified.
   *  3. Move ride to WAITING_FOR_ACCEPTANCE, notify the batch.
   *  4. Schedule a timeout; if nobody accepts within ACCEPT_TIMEOUT_SECONDS,
   *     re-run this method to search the NEXT nearest batch (retry flow).
   */
  private async searchAndNotify(rideId: string): Promise<void> {
    const ride = await this.rideRepo.findOne({ where: { id: rideId } });
    if (!ride || ride.status === RideStatus.ASSIGNED || ride.status === RideStatus.CANCELLED) {
      return; // Already resolved, nothing to do.
    }

    await this.rideRepo.update({ id: rideId }, { status: RideStatus.SEARCHING });

    const excluded = Array.from(this.notifiedDrivers.get(rideId) ?? []);
    const nearest = await this.redisService.findNearestAvailableDrivers(
      ride.pickupLongitude,
      ride.pickupLatitude,
      SEARCH_RADIUS_KM,
      BATCH_SIZE,
      excluded,
    );

    if (nearest.length === 0) {
      this.logger.warn(`No available drivers found for ride ${rideId} (radius ${SEARCH_RADIUS_KM}km)`);
      // Leave ride in SEARCHING; a real system would keep polling or expand radius.
      // No one is eligible to accept this wave, so the active-wave set is empty.
      this.activeWaveDrivers.set(rideId, new Set());
      this.armTimeout(rideId);
      return;
    }

    await this.rideRepo.update({ id: rideId }, { status: RideStatus.WAITING_FOR_ACCEPTANCE });

    const excludeSet = this.notifiedDrivers.get(rideId) ?? new Set<string>();
    const currentWave = new Set<string>();
    for (const { driverId, distanceKm } of nearest) {
      excludeSet.add(driverId);
      currentWave.add(driverId);
      await this.logRepo.save(
        this.logRepo.create({ rideId, driverId, status: AssignmentLogStatus.NOTIFIED }),
      );
      this.notificationService.notifyDriverOfRideRequest(driverId, rideId, distanceKm);
    }
    this.notifiedDrivers.set(rideId, excludeSet);
    // Only THIS wave's drivers may accept until it times out or the ride resolves.
    this.activeWaveDrivers.set(rideId, currentWave);

    this.armTimeout(rideId);
  }

  /** Schedules (or re-schedules) the acceptance timeout for a ride. */
  private armTimeout(rideId: string): void {
    this.clearTimeoutFor(rideId);
    const handle = setTimeout(() => {
      this.handleTimeout(rideId).catch((err) =>
        this.logger.error(`handleTimeout failed for ride ${rideId}: ${err.message}`),
      );
    }, ACCEPT_TIMEOUT_SECONDS * 1000);
    this.timeoutHandles.set(rideId, handle);
  }

  private clearTimeoutFor(rideId: string): void {
    const existing = this.timeoutHandles.get(rideId);
    if (existing) {
      clearTimeout(existing);
      this.timeoutHandles.delete(rideId);
    }
  }

  /**
   * TIMEOUT FLOW: if a ride is still unassigned after the wait window,
   * mark the current wave as TIMED_OUT in the audit log, flip ride status
   * to TIMEOUT, and retry with the next nearest batch of drivers.
   */
  private async handleTimeout(rideId: string): Promise<void> {
    const ride = await this.rideRepo.findOne({ where: { id: rideId } });
    if (!ride || ride.status === RideStatus.ASSIGNED || ride.status === RideStatus.CANCELLED) {
      return; // Resolved already — nothing to time out.
    }

    this.logger.warn(`Ride ${rideId} timed out waiting for acceptance — retrying with next batch`);
    this.notificationService.notifyRideTimeout(rideId);

    // Immediately revoke this wave's drivers' right to accept — anyone from the
    // expired wave who calls accept() after this point is a "late acceptance".
    this.activeWaveDrivers.set(rideId, new Set());

    await this.rideRepo.update({ id: rideId }, { status: RideStatus.TIMEOUT });

    // Mark all NOTIFIED logs for this wave as TIMED_OUT (best-effort audit).
    await this.logRepo
      .createQueryBuilder()
      .update(RideAssignmentLog)
      .set({ status: AssignmentLogStatus.TIMED_OUT })
      .where('rideId = :rideId AND status = :status', {
        rideId,
        status: AssignmentLogStatus.NOTIFIED,
      })
      .execute();

    // Retry: search the next nearest batch (excluding everyone already tried).
    await this.searchAndNotify(rideId);
  }

  // ---------------------------------------------------------------------
  // CONCURRENCY-SAFE ACCEPT — the critical path
  // ---------------------------------------------------------------------

  /**
   * Driver accepts a ride. Guarantees, even under 100 simultaneous callers:
   *   - Exactly one driver is ever assigned.
   *   - Late acceptance (after timeout/reassignment) is rejected.
   *   - Repeated accepts from the SAME driver are idempotent (no duplicate assignment,
   *     no error on the winning driver retrying).
   *
   * Strategy (defense in depth):
   *   1. Acquire a short-lived Redis distributed lock scoped to the ride ("lock:ride:{id}").
   *      Only one caller can hold it at a time; others fail fast with 409.
   *   2. Inside the lock, atomically try to write the ride's assignment key with NX.
   *      This is the true source of truth — even if the lock were somehow bypassed,
   *      the NX write guarantees a single winner.
   *   3. Release the lock (safe-release via Lua, only if we still own it).
   */
  async acceptRide(rideId: string, driverId: string): Promise<Ride> {
    const ride = await this.rideRepo.findOne({ where: { id: rideId } });
    if (!ride) throw new NotFoundException(`Ride ${rideId} not found`);

    // Fast idempotency check before even trying the lock: if this driver already
    // won, just return the ride as-is instead of erroring.
    const existingAssignment = await this.redisService.getRideAssignment(rideId);
    if (existingAssignment) {
      if (existingAssignment === driverId) {
        return ride; // Idempotent: same driver clicking Accept multiple times.
      }
      throw new GoneException('Ride has already been assigned to another driver');
    }

    if ([RideStatus.CANCELLED, RideStatus.COMPLETED].includes(ride.status)) {
      throw new BadRequestException(`Ride is ${ride.status} and can no longer be accepted`);
    }

    // LATE ACCEPTANCE CHECK: a driver may only accept if they belong to the
    // CURRENT notification wave. Once a wave's 15s window expires, its drivers
    // are evicted from this set (see handleTimeout), so any accept() from them
    // arriving after that point — even if it arrives before the retry re-notifies
    // a new batch — is rejected as a late acceptance, per spec.
    const activeWave = this.activeWaveDrivers.get(rideId);
    if (!activeWave || !activeWave.has(driverId)) {
      await this.logRepo.save(
        this.logRepo.create({ rideId, driverId, status: AssignmentLogStatus.LATE_ACCEPT_REJECTED }),
      );
      throw new GoneException(
        'Late acceptance: this ride is no longer waiting on you (your window expired or you were never notified)',
      );
    }

    // --- Step 1: acquire distributed lock ---
    const lockToken = await this.redisService.acquireLock(rideId, 5000);
    if (!lockToken) {
      // Someone else is mid-assignment for this ride right now.
      throw new ConflictException('Ride is currently being assigned to another driver, try again');
    }

    try {
      // Re-check under the lock (another request may have just finished).
      const assignedNow = await this.redisService.getRideAssignment(rideId);
      if (assignedNow) {
        if (assignedNow === driverId) return ride;
        throw new GoneException('Ride has already been assigned to another driver');
      }

      // LATE ACCEPTANCE CHECK: if the ride already moved past the acceptance
      // window (TIMEOUT re-triggered a new wave that excluded this driver,
      // or ride was cancelled), reject.
      const fresh = await this.rideRepo.findOne({ where: { id: rideId } });
      if (!fresh || fresh.status === RideStatus.CANCELLED || fresh.status === RideStatus.COMPLETED) {
        throw new BadRequestException('Ride is no longer accepting drivers');
      }

      // --- Step 2: atomic NX assignment (the real single-writer guarantee) ---
      const won = await this.redisService.tryAssignRideAtomically(rideId, driverId);
      if (!won) {
        // Extremely unlikely race outside the lock's protection, but handled anyway.
        throw new GoneException('Ride has already been assigned to another driver');
      }

      // --- Step 3: persist the win ---
      this.clearTimeoutFor(rideId);
      fresh.status = RideStatus.ASSIGNED;
      fresh.assignedDriverId = driverId;
      await this.rideRepo.save(fresh);

      await this.redisService.markDriverUnavailable(driverId);

      await this.logRepo.save(
        this.logRepo.create({ rideId, driverId, status: AssignmentLogStatus.ACCEPTED }),
      );

      // Mark any other still-NOTIFIED drivers for this ride as REJECTED (lost the race).
      await this.logRepo
        .createQueryBuilder()
        .update(RideAssignmentLog)
        .set({ status: AssignmentLogStatus.REJECTED })
        .where('rideId = :rideId AND status = :status AND driverId != :driverId', {
          rideId,
          status: AssignmentLogStatus.NOTIFIED,
          driverId,
        })
        .execute();

      this.notificationService.notifyRideAssigned(rideId, driverId);
      this.logger.log(`Ride ${rideId} ASSIGNED to driver ${driverId}`);

      return fresh;
    } finally {
      // --- Step 4: always release the lock, even on error ---
      await this.redisService.releaseLock(rideId, lockToken);
    }
  }

  // ---------------------------------------------------------------------
  // Completion
  // ---------------------------------------------------------------------

  async completeRide(rideId: string): Promise<Ride> {
    const ride = await this.rideRepo.findOne({ where: { id: rideId } });
    if (!ride) throw new NotFoundException(`Ride ${rideId} not found`);
    if (ride.status !== RideStatus.ASSIGNED) {
      throw new BadRequestException(`Only ASSIGNED rides can be completed (current: ${ride.status})`);
    }

    ride.status = RideStatus.COMPLETED;
    await this.rideRepo.save(ride);

    if (ride.assignedDriverId) {
      await this.redisService.markDriverAvailable(ride.assignedDriverId);
    }

    // Clean up in-memory bookkeeping for this ride.
    this.clearTimeoutFor(rideId);
    this.notifiedDrivers.delete(rideId);
    this.activeWaveDrivers.delete(rideId);

    this.logger.log(`Ride ${rideId} COMPLETED, driver ${ride.assignedDriverId} is now available`);
    return ride;
  }

  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  async findAll(): Promise<Ride[]> {
    return this.rideRepo.find({ order: { createdAt: 'DESC' } });
  }

  async findOne(id: string): Promise<Ride> {
    const ride = await this.rideRepo.findOne({ where: { id } });
    if (!ride) throw new NotFoundException(`Ride ${id} not found`);
    return ride;
  }
}
