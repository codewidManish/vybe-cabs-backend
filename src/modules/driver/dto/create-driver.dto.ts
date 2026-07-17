import { ApiProperty } from '@nestjs/swagger';
import { IsLatitude, IsLongitude, IsNotEmpty, IsString } from 'class-validator';

export class CreateDriverDto {
  @ApiProperty({ example: 'Ramesh Kumar' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 28.6139 })
  @IsLatitude()
  latitude: number;

  @ApiProperty({ example: 77.209 })
  @IsLongitude()
  longitude: number;
}
