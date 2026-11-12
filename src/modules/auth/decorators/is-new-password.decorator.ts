import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsByteLength, IsString, Matches, MinLength } from 'class-validator';
import {
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
} from '@/common/constants/account-field.constant.js';
import { keepAsSent } from '@/common/utils/string-transform.util.js';

const HAS_NON_WHITESPACE_CHARACTER = /\S/;

/** Password policy for choosing a new password (registration, password change). */
export function IsNewPassword() {
  return applyDecorators(
    Transform(keepAsSent),
    IsString(),
    MinLength(PASSWORD_MIN_LENGTH),
    IsByteLength(0, PASSWORD_MAX_BYTES, {
      message: `$property must not exceed ${PASSWORD_MAX_BYTES} UTF-8 bytes`,
    }),
    Matches(HAS_NON_WHITESPACE_CHARACTER, {
      message: '$property must contain a non-whitespace character',
    }),
  );
}
