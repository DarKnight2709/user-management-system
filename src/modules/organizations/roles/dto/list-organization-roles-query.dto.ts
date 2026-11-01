import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { ListOrganizationsQueryDto } from '../../dto/list-organizations-query.dto.js';

export const organizationRoleTypes = ['BUILT_IN', 'CUSTOM'] as const;
export type OrganizationRoleType = (typeof organizationRoleTypes)[number];

export class ListOrganizationRolesQueryDto extends ListOrganizationsQueryDto {
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
  @IsIn(organizationRoleTypes)
  type?: OrganizationRoleType;

  @IsOptional()
  @IsUUID()
  permissionId?: string;
}
