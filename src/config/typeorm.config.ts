import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { Driver } from '../modules/driver/entities/driver.entity';
import { Ride } from '../modules/ride/entities/ride.entity';
import { RideAssignmentLog } from '../modules/ride/entities/ride-assignment-log.entity';

/**
 * Builds TypeORM configuration from environment variables.
 * `synchronize: true` is used here for fast local bootstrapping; in a real
 * production rollout this should be replaced with versioned migrations.
 */
export function typeOrmConfig(configService: ConfigService = new ConfigService()): TypeOrmModuleOptions {
  return {
    type: 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    username: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || 'root123',
    database: process.env.DB_DATABASE || 'vybe_cabs',
    entities: [Driver, Ride, RideAssignmentLog],
    synchronize: true,
    logging: false,
  };
}
