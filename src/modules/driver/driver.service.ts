import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Driver } from './entities/driver.entity';
import { CreateDriverDto } from './dto/create-driver.dto';
import { UpdateDriverLocationDto } from './dto/update-driver-location.dto';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class DriverService {
  private readonly logger = new Logger(DriverService.name);

  constructor(
    @InjectRepository(Driver) private readonly driverRepo: Repository<Driver>,
    private readonly redisService: RedisService,
  ) {}

  /** Creates a driver in Postgres and seeds their initial GEO position + availability in Redis. */
  async create(dto: CreateDriverDto): Promise<Driver> {
    const driver = this.driverRepo.create({
      name: dto.name,
      latitude: dto.latitude,
      longitude: dto.longitude,
      available: true,
    });
    const saved = await this.driverRepo.save(driver);

    await this.redisService.updateDriverLocation(saved.id, dto.longitude, dto.latitude);
    await this.redisService.markDriverAvailable(saved.id);

    this.logger.log(`Driver created: ${saved.id} (${saved.name})`);
    return saved;
  }

  /** Updates a driver's live location. Redis GEO index is the hot path used for search. */
  async updateLocation(dto: UpdateDriverLocationDto): Promise<Driver> {
    const driver = await this.driverRepo.findOne({ where: { id: dto.driverId } });
    if (!driver) throw new NotFoundException(`Driver ${dto.driverId} not found`);

    driver.latitude = dto.latitude;
    driver.longitude = dto.longitude;
    await this.driverRepo.save(driver);

    await this.redisService.updateDriverLocation(driver.id, dto.longitude, dto.latitude);
    return driver;
  }

  async findAll(): Promise<Driver[]> {
    return this.driverRepo.find({ order: { createdAt: 'DESC' } });
  }

  async findOne(id: string): Promise<Driver> {
    const driver = await this.driverRepo.findOne({ where: { id } });
    if (!driver) throw new NotFoundException(`Driver ${id} not found`);
    return driver;
  }

  /** Flips availability in both Postgres (durable) and Redis (hot path used by search). */
  async setAvailability(id: string, available: boolean): Promise<void> {
    await this.driverRepo.update({ id }, { available });
    if (available) {
      await this.redisService.markDriverAvailable(id);
    } else {
      await this.redisService.markDriverUnavailable(id);
    }
  }
}
