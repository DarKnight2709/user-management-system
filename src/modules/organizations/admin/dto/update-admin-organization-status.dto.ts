import { Transform } from 'class-transformer';
import { IsIn } from 'class-validator';

export const manageableOrganizationStatuses = ['ACTIVE', 'SUSPENDED'] as const;

export type ManageableOrganizationStatus =
  (typeof manageableOrganizationStatuses)[number];

export class UpdateAdminOrganizationStatusDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsIn(manageableOrganizationStatuses)
  status: ManageableOrganizationStatus;
}
