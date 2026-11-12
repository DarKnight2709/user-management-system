import { Transform } from 'class-transformer';
import { IsString, Matches } from 'class-validator';
import { keepAsSent } from '@/common/utils/string-transform.util.js';
import { SECURITY_TOKEN_PATTERN } from '../constants/account-security.constant.js';

export class VerifyEmailDto {
  @Transform(keepAsSent)
  @IsString()
  @Matches(SECURITY_TOKEN_PATTERN, { message: 'token is malformed' })
  token: string;
}
