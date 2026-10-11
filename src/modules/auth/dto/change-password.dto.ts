import { IsByteLength, IsNotEmpty, IsString, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  currentPassword: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(15)
  @IsByteLength(0, 72, {
    message: 'newPassword must not exceed 72 UTF-8 bytes',
  })
  newPassword: string;
}
