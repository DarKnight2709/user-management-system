import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { InvitationStatus } from '@/generated/prisma/enums.js';
import { ListOrganizationsQueryDto } from '../../dto/list-organizations-query.dto.js';

export class ListInvitationsQueryDto extends ListOrganizationsQueryDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() || undefined : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(254)
  email?: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsOptional()
  @IsEnum(InvitationStatus)
  status?: InvitationStatus;
}
