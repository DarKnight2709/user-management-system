import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ListOrganizationsQueryDto } from '../../dto/list-organizations-query.dto.js';

export const adminOrganizationStatuses = [
  'ACTIVE',
  'SUSPENDED',
  'DELETED',
] as const;

export type AdminOrganizationStatus =
  (typeof adminOrganizationStatuses)[number];

export class ListAdminOrganizationsQueryDto extends ListOrganizationsQueryDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsOptional()
  @IsIn(adminOrganizationStatuses)
  status?: AdminOrganizationStatus;
}
