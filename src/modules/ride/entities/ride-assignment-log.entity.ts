import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { AssignmentLogStatus } from '../../../common/enums/assignment-log-status.enum';

/**
 * Audit trail of every driver notified/accepted/rejected for a ride —
 * essential for RCA (why wasn't ride X assigned faster / who declined).
 */
@Entity('ride_assignment_logs')
@Index(['rideId'])
export class RideAssignmentLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  rideId: string;

  @Column()
  driverId: string;

  @Column({ type: 'enum', enum: AssignmentLogStatus })
  status: AssignmentLogStatus;

  @CreateDateColumn()
  createdAt: Date;
}
