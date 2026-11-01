import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ListOrganizationsQueryDto } from '../../dto/list-organizations-query.dto.js';

export class ListOrganizationRolesQueryDto extends ListOrganizationsQueryDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}
