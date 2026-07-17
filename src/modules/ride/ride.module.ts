import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Ride } from './entities/ride.entity';
import { RideAssignmentLog } from './entities/ride-assignment-log.entity';
import { RideService } from './ride.service';
import { RideController } from './ride.controller';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [TypeOrmModule.forFeature([Ride, RideAssignmentLog]), NotificationModule],
  providers: [RideService],
  controllers: [RideController],
  exports: [RideService],
})
export class RideModule {}
