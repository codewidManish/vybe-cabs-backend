/**
 * simulate-concurrency.ts
 * ------------------------------------------------------------------
 * End-to-end concurrency proof against a RUNNING instance of the app
 * (npm run start:dev must be active on PORT, default 3000).
 *
 * Steps:
 *   1. Register 100 REAL drivers, all at the exact same coordinates as
 *      the pickup point. Because acceptRide() enforces the "late
 *      acceptance" rule (only drivers in the ride's current notification
 *      wave may accept — see RideService.activeWaveDrivers), whichever
 *      N = NEAREST_DRIVER_BATCH_SIZE drivers Redis GEOSEARCH picks as
 *      "nearest" are guaranteed to come from this pool of 100, since they
 *      all share the pickup's exact coordinates. This keeps the test
 *      valid regardless of the server's configured batch size.
 *   2. Create a ride at that same pickup point.
 *   3. Fire 100 concurrent POST /rides/:id/accept requests, one per
 *      registered driver.
 *   4. Report exactly one success and 99 failures (a mix of "lost the
 *      lock/atomic-assignment race" for drivers who WERE notified, and
 *      "late acceptance" for drivers who were never part of the wave)
 *      plus total execution time.
 *
 *   Tip: to see all 100 drivers genuinely notified in a single wave
 *   (rather than the default batch of 5), start the server with
 *   NEAREST_DRIVER_BATCH_SIZE=100 before running this script.
 *
 * Run:  npm run simulate:concurrency
 */
import axios from 'axios';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const CONCURRENT_DRIVERS = 100;
const PICKUP = { latitude: 28.6139, longitude: 77.209 };

async function main() {
  console.log('🚕 Vybe Cabs — Concurrency Simulation');
  console.log('======================================');

  // 1. Register 100 real drivers at the exact pickup coordinates, so
  //    whichever subset Redis GEOSEARCH selects as "nearest" is drawn
  //    from this pool — every one of the 100 is a legitimate candidate.
  console.log(`Registering ${CONCURRENT_DRIVERS} real drivers at the pickup point...`);
  const driverIds: string[] = [];
  for (let i = 0; i < CONCURRENT_DRIVERS; i++) {
    const res = await axios.post(`${BASE_URL}/drivers`, {
      name: `Sim Driver ${i + 1}`,
      latitude: PICKUP.latitude,
      longitude: PICKUP.longitude,
    });
    driverIds.push(res.data.id);
  }
  console.log(`Registered ${driverIds.length} drivers.`);

  const rideRes = await axios.post(`${BASE_URL}/rides`, {
    riderName: 'Concurrency Test Rider',
    pickupLatitude: PICKUP.latitude,
    pickupLongitude: PICKUP.longitude,
  });
  const rideId = rideRes.data.id;
  console.log(`Ride created: ${rideId}`);

  // Small delay to let the async search/notify wave run at least once.
  await new Promise((r) => setTimeout(r, 800));

  console.log(`Firing ${CONCURRENT_DRIVERS} parallel accept requests...`);
  const start = Date.now();

  const results = await Promise.allSettled(
    driverIds.map((driverId) =>
      axios.post(`${BASE_URL}/rides/${rideId}/accept`, { driverId }),
    ),
  );

  const durationMs = Date.now() - start;

  const successes: string[] = [];
  const rejections: { driverId: string; reason: string }[] = [];

  results.forEach((result, idx) => {
    if (result.status === 'fulfilled') {
      successes.push(driverIds[idx]);
    } else {
      const err = result as PromiseRejectedResult;
      const reason =
        err.reason?.response?.data?.message || err.reason?.message || 'Unknown error';
      rejections.push({ driverId: driverIds[idx], reason });
    }
  });

  console.log('\n===== RESULTS =====');
  console.log(`Successful Driver(s): ${successes.length === 1 ? successes[0] : JSON.stringify(successes)}`);
  console.log(`Rejected Drivers: ${rejections.length}`);
  console.log(`Execution Time: ${durationMs}ms`);
  console.log('====================\n');

  if (successes.length === 1) {
    console.log('✅ PASS: Exactly one driver was assigned. No race condition detected.');
  } else {
    console.error(`❌ FAIL: Expected exactly 1 success, got ${successes.length}.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Simulation failed:', err.message);
  process.exitCode = 1;
});
