import { Transform } from 'class-transformer';
import { IsEmail, IsString, Matches, MaxLength } from 'class-validator';
import { EMAIL_MAX_LENGTH } from '@/common/constants/account-field.constant.js';
import {
  keepAsSent,
  trimAndLowercase,
} from '@/common/utils/string-transform.util.js';
import { IsNewPassword } from '@/modules/auth/decorators/is-new-password.decorator.js';
import { SECURITY_TOKEN_PATTERN } from '../constants/account-security.constant.js';

export class ForgotPasswordDto {
  @Transform(trimAndLowercase)
  @IsEmail()
  @MaxLength(EMAIL_MAX_LENGTH)
  email: string;
}

export class ResetPasswordDto {
  @Transform(keepAsSent)
  @IsString()
  @Matches(SECURITY_TOKEN_PATTERN, { message: 'token is malformed' })
  token: string;

  @IsNewPassword()
  newPassword: string;
}
