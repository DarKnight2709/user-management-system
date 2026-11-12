import { Transform } from 'class-transformer';
import {
  IsByteLength,
  IsEmail,
  IsJWT,
  IsNotEmpty,
  IsString,
  MaxLength,
} from 'class-validator';
import { EMAIL_MAX_LENGTH } from '@/common/constants/account-field.constant.js';
import { trimAndLowercase } from '@/common/utils/string-transform.util.js';
import { UserProfileDto } from '@/modules/users/dto/user-profile.dto.js';
import { LOGIN_PASSWORD_MAX_BYTES } from '../constants/auth.constant.js';
import { IsNewPassword } from '../decorators/is-new-password.decorator.js';

export class LoginDto {
  @Transform(trimAndLowercase)
  @IsEmail()
  @IsNotEmpty()
  @MaxLength(EMAIL_MAX_LENGTH)
  email: string;

  @IsString()
  @IsNotEmpty()
  @IsByteLength(1, LOGIN_PASSWORD_MAX_BYTES, {
    message: `password must not exceed ${LOGIN_PASSWORD_MAX_BYTES} bytes`,
  })
  password: string;
}

export class RefreshTokenDto {
  @IsString()
  @IsJWT()
  @MaxLength(4096)
  refreshToken: string;
}

export class RegisterDto extends UserProfileDto {
  @IsNewPassword()
  password: string;
}
