import { Transform } from 'class-transformer';
import {
  IsByteLength,
  IsDate,
  IsEmail,
  IsJWT,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  EMAIL_MAX_LENGTH,
  LOGIN_PASSWORD_MAX_BYTES,
} from '../constants/auth.constant.js';

export class LoginDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
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

export class RegisterDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @MinLength(1)
  @IsNotEmpty()
  username: string;

  @IsString()
  @MinLength(1)
  @IsNotEmpty()
  firstName: string;

  @IsString()
  @MinLength(1)
  @IsNotEmpty()
  lastName: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(15)
  @IsByteLength(0, 72, {
    message: 'password must not exceed 72 UTF-8 bytes',
  })
  password: string;

  @IsDate()
  @IsNotEmpty()
  birthDate: Date;
}
