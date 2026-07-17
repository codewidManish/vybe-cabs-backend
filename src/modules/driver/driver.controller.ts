import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { DriverService } from './driver.service';
import { CreateDriverDto } from './dto/create-driver.dto';
import { UpdateDriverLocationDto } from './dto/update-driver-location.dto';
import { Driver } from './entities/driver.entity';

@ApiTags('drivers')
@Controller('drivers')
export class DriverController {
  constructor(private readonly driverService: DriverService) {}

  @Post()
  @ApiOperation({ summary: 'Register a new driver' })
  @ApiResponse({ status: 201, description: 'Driver created', type: Driver })
  create(@Body() dto: CreateDriverDto) {
    return this.driverService.create(dto);
  }

  @Patch('location')
  @ApiOperation({ summary: "Update a driver's live GPS location (writes to Redis GEO index)" })
  updateLocation(@Body() dto: UpdateDriverLocationDto) {
    return this.driverService.updateLocation(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List all drivers' })
  findAll() {
    return this.driverService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single driver by id' })
  findOne(@Param('id') id: string) {
    return this.driverService.findOne(id);
  }
}
