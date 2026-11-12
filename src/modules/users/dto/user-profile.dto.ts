import { Transform, Type } from 'class-transformer';
import {
  IsDate,
  IsEmail,
  IsString,
  Length,
  Matches,
  MaxDate,
  MaxLength,
  MinDate,
} from 'class-validator';
import {
  EMAIL_MAX_LENGTH,
  MAX_AGE_YEARS,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_PATTERN,
} from '@/common/constants/account-field.constant.js';
import { yearsAgo } from '@/common/utils/date.util.js';
import { trimAndLowercase } from '@/common/utils/string-transform.util.js';
import { IsPersonName } from '@/common/validators/is-person-name.decorator.js';

/** Profile fields shared by registration, account creation and profile updates. */
export class UserProfileDto {
  @Transform(trimAndLowercase)
  @IsString()
  @Length(USERNAME_MIN_LENGTH, USERNAME_MAX_LENGTH)
  @Matches(USERNAME_PATTERN, {
    message:
      'username must start with a letter or digit and contain only lowercase letters, digits, dots, underscores and hyphens',
  })
  username: string;

  @IsPersonName()
  firstName: string;

  @IsPersonName()
  lastName: string;

  @Transform(trimAndLowercase)
  @IsEmail()
  @MaxLength(EMAIL_MAX_LENGTH)
  email: string;

  @Type(() => Date)
  @IsDate()
  @MinDate(() => yearsAgo(MAX_AGE_YEARS))
  @MaxDate(() => new Date())
  birthDate: Date;
}
