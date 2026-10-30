import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { AuditTargetType } from '@/generated/prisma/enums.js';
import { AUDIT_POLICIES } from '@/modules/logging/policies/audit-event.policy.js';
import type { AuditEventName } from '@/modules/logging/types/audit-event.types.js';
import { ORGANIZATION_AUDIT_ACTIONS } from '../audit-action.constants.js';

abstract class AuditEventQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  page: number = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @IsOptional()
  @IsUUID()
  actorId?: string;

  @IsOptional()
  @IsUUID()
  targetId?: string;

  @IsOptional()
  @IsIn(Object.values(AuditTargetType))
  targetType?: AuditTargetType;
}

export class ListAuditEventsQueryDto extends AuditEventQueryDto {
  @IsOptional()
  @IsIn(Object.keys(AUDIT_POLICIES))
  action?: AuditEventName;
}

export class ListOrganizationAuditEventsQueryDto extends AuditEventQueryDto {
  @IsOptional()
  @IsIn(ORGANIZATION_AUDIT_ACTIONS)
  action?: (typeof ORGANIZATION_AUDIT_ACTIONS)[number];
}

export class ListPlatformAuditEventsQueryDto extends ListAuditEventsQueryDto {
  @IsOptional()
  @IsUUID()
  organizationId?: string;
}
