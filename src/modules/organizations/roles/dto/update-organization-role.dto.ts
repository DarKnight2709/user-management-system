import { PartialType } from '@nestjs/swagger';
import { CreateOrganizationRoleDto } from './create-organization-role.dto.js';

export class UpdateOrganizationRoleDto extends PartialType(
  CreateOrganizationRoleDto,
  {
    skipNullProperties: false,
  },
) {}
