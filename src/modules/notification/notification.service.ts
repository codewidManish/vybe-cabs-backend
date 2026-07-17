import { Injectable, Logger } from '@nestjs/common';
import { NotificationGateway } from './notification.gateway';

/**
 * Simulates the notification system: logs + pushes over WebSocket.
 * Kept as a thin service so it can later be swapped for FCM/APNs/SMS
 * without touching the ride-assignment logic.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(private readonly gateway: NotificationGateway) {}

  notifyDriverOfRideRequest(driverId: string, rideId: string, distanceKm: number) {
    this.logger.log(
      `📲 Notifying driver ${driverId} about ride ${rideId} (${distanceKm.toFixed(2)} km away)`,
    );
    this.gateway.notifyDriver(driverId, { rideId, distanceKm, type: 'RIDE_REQUEST' });
  }

  notifyRideAssigned(rideId: string, driverId: string) {
    this.logger.log(`✅ Ride ${rideId} assigned to driver ${driverId}`);
    this.gateway.notifyDriver(driverId, { rideId, type: 'RIDE_ASSIGNED' });
  }

  notifyRideTimeout(rideId: string) {
    this.logger.warn(`⏱️ Ride ${rideId} timed out waiting for driver acceptance`);
  }
}
