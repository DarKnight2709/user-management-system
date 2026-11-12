import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsString, Length, Matches } from 'class-validator';
import { NAME_MAX_LENGTH } from '@/common/constants/account-field.constant.js';
import { trimText } from '@/common/utils/string-transform.util.js';

const NO_CONTROL_CHARACTERS = /^[^\p{Cc}]*$/u;

/** A trimmed, non-empty name without control characters (such as newlines). */
export function IsPersonName() {
  return applyDecorators(
    Transform(trimText),
    IsString(),
    Length(1, NAME_MAX_LENGTH),
    Matches(NO_CONTROL_CHARACTERS, {
      message: '$property must not contain control characters',
    }),
  );
}
