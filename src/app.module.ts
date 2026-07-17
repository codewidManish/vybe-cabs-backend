import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { typeOrmConfig } from './config/typeorm.config';
import { RedisModule } from './modules/redis/redis.module';
import { DriverModule } from './modules/driver/driver.module';
import { RideModule } from './modules/ride/ride.module';
import { NotificationModule } from './modules/notification/notification.module';

@Module({
  imports: [
    // Loads .env into process.env and makes ConfigService available app-wide
    ConfigModule.forRoot({ isGlobal: true }),

    // Enables in-process pub/sub used to decouple ride-assignment events from notifications
    EventEmitterModule.forRoot(),

    // PostgreSQL connection via TypeORM
    TypeOrmModule.forRootAsync({ useFactory: typeOrmConfig }),

    RedisModule,
    DriverModule,
    RideModule,
    NotificationModule,
  ],
})
export class AppModule {}
