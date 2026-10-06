import {
  IsDate,
  IsEmail,
  IsJWT,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class LoginDto {
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty()
  password: string;
}

export class RefreshTokenDto {
  @IsString()
  @IsJWT()
  @MaxLength(4096)
  refreshToken: string;
}

export class RegisterDto {
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

  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty()
  password: string;

  @IsDate()
  @IsNotEmpty()
  birthDate: Date;
}
