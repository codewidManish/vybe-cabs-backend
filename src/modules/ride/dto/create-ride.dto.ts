import { ApiProperty } from '@nestjs/swagger';
import { IsLatitude, IsLongitude, IsNotEmpty, IsString } from 'class-validator';

export class CreateRideDto {
  @ApiProperty({ example: 'Anjali Sharma' })
  @IsString()
  @IsNotEmpty()
  riderName: string;

  @ApiProperty({ example: 28.6129 })
  @IsLatitude()
  pickupLatitude: number;

  @ApiProperty({ example: 77.2295 })
  @IsLongitude()
  pickupLongitude: number;
}
