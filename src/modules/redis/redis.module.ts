import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';

/**
 * Global module so RedisService (connection, GEO helpers, distributed lock)
 * can be injected anywhere without re-importing.
 */
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
