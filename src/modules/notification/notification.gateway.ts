import { Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

/**
 * WebSocket gateway simulating push notifications to driver mobile apps.
 * In production, driver apps would join a room named after their driverId;
 * here we broadcast on a `driver:{driverId}:ride-request` event so any
 * connected client subscribed to that room receives it in real time.
 */
@WebSocketGateway({ cors: { origin: '*' }, namespace: '/notifications' })
export class NotificationGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(NotificationGateway.name);

  @WebSocketServer()
  server: Server;

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  /** Emits a ride-request notification to a specific driver's room. */
  notifyDriver(driverId: string, payload: Record<string, any>) {
    this.server?.to(`driver:${driverId}`).emit('ride-request', payload);
  }
}
