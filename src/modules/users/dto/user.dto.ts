import {
  IsEmail,
  IsNotEmpty,
  IsNumber,
  IsString,
  Min,
  MinLength,
} from 'class-validator';

export class UserDto {
  @IsString()
  @MinLength(1)
  @IsNotEmpty()
  name: string;

  @IsNumber()
  @IsNotEmpty()
  @Min(1)
  age: number;

  @IsEmail()
  @IsNotEmpty()
  email: string;
}
