import { IsNotEmpty, IsString } from 'class-validator';
import { UserProfileDto } from './user-profile.dto.js';

export class CreateUserDto extends UserProfileDto {
  @IsString()
  @IsNotEmpty()
  hashedPassword: string;
}

export class UpdateUserDto extends UserProfileDto {}
