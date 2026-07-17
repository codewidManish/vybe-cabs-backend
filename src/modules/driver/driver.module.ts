import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Driver } from './entities/driver.entity';
import { DriverService } from './driver.service';
import { DriverController } from './driver.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Driver])],
  providers: [DriverService],
  controllers: [DriverController],
  exports: [DriverService],
})
export class DriverModule {}
