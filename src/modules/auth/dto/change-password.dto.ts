import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString } from 'class-validator';
import { keepAsSent } from '@/common/utils/string-transform.util.js';
import { IsNewPassword } from '../decorators/is-new-password.decorator.js';

export class ChangePasswordDto {
  @Transform(keepAsSent)
  @IsString()
  @IsNotEmpty()
  currentPassword: string;

  @IsNewPassword()
  newPassword: string;
}
