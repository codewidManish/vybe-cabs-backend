import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RideService } from './ride.service';
import { CreateRideDto } from './dto/create-ride.dto';
import { AcceptRideDto } from './dto/accept-ride.dto';
import { Ride } from './entities/ride.entity';

@ApiTags('rides')
@Controller('rides')
export class RideController {
  constructor(private readonly rideService: RideService) {}

  @Post()
  @ApiOperation({ summary: 'Request a new ride. Triggers async nearest-driver search + notification.' })
  @ApiResponse({ status: 201, description: 'Ride created and search kicked off', type: Ride })
  create(@Body() dto: CreateRideDto) {
    return this.rideService.createRide(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List all rides' })
  findAll() {
    return this.rideService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single ride by id' })
  findOne(@Param('id') id: string) {
    return this.rideService.findOne(id);
  }

  @Post(':id/accept')
  @ApiOperation({
    summary:
      'Driver accepts a ride. Concurrency-safe: only ONE of many simultaneous callers wins, ' +
      'via a Redis distributed lock + atomic NX assignment key. Idempotent per driver.',
  })
  accept(@Param('id') id: string, @Body() dto: AcceptRideDto) {
    return this.rideService.acceptRide(id, dto.driverId);
  }

  @Patch(':id/complete')
  @ApiOperation({ summary: 'Mark ride as completed and free the assigned driver' })
  complete(@Param('id') id: string) {
    return this.rideService.completeRide(id);
  }
}
