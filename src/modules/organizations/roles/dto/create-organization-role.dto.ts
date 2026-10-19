import { organizationPermissions } from '@/common/constants/organization-permissions.constant.js';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsString,
  IsUUID,
  Matches,
  IsNotIn,
} from 'class-validator';

export class CreateOrganizationRoleDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{0,49}$/, {
    message:
      'name must start with a letter and contain at most 50 letters, numbers or underscores',
  })
  @IsNotIn(['OWNER', 'ADMIN', 'MEMBER'])
  name: string;

  @IsArray()
  @ArrayMaxSize(organizationPermissions.length)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  permissionIds: string[];
}
