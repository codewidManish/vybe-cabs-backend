import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class AcceptRideDto {
  @ApiProperty({ example: 'a3f1c2e4-1234-4a5b-9c6d-abcdef123456' })
  @IsUUID()
  driverId: string;
}
