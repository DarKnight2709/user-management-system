import { PickType } from '@nestjs/swagger';
import { CreateOrganizationDto } from './create-organization.dto.js';

// Name is the only editable field in this operation and remains required.
export class UpdateOrganizationDto extends PickType(CreateOrganizationDto, [
  'name',
] as const) {}
