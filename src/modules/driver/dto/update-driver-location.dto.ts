import { ApiProperty } from '@nestjs/swagger';
import { IsLatitude, IsLongitude, IsUUID } from 'class-validator';

export class UpdateDriverLocationDto {
  @ApiProperty({ example: 'a3f1c2e4-1234-4a5b-9c6d-abcdef123456' })
  @IsUUID()
  driverId: string;

  @ApiProperty({ example: 28.6145 })
  @IsLatitude()
  latitude: number;

  @ApiProperty({ example: 77.2101 })
  @IsLongitude()
  longitude: number;
}
