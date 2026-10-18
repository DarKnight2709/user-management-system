import { Transform } from 'class-transformer';
import { IsEmail, IsString, Matches, MaxLength } from 'class-validator';

export class CreateInvitationDto {
  @Transform(({ obj }: { obj: Record<string, unknown> }) =>
    typeof obj.email === 'string' ? obj.email.trim().toLowerCase() : obj.email,
  )
  @IsString()
  @IsEmail()
  @MaxLength(254)
  email: string;
}

export class AcceptInvitationDto {
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  token: string;
}
