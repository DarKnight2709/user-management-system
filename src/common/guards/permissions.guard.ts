import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { isUUID } from 'class-validator';
import {
  PLATFORM_PERMISSIONS_KEY,
  type PlatformPermission,
} from '../decorators/require-platform-permissions.decorator.js';
import {
  ORGANIZATION_PERMISSIONS_KEY,
  type OrganizationPermissionRequirement,
} from '../decorators/require-organization-permissions.decorator.js';

import { PermissionsService } from '@/common/services/permissions.service.js';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,

    private readonly permissionsService: PermissionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // When both decorators are present, both requirements must pass.
    await this.checkPlatformPermissions(context);
    await this.checkOrganizationPermissions(context);
    return true;
  }

  private async checkPlatformPermissions(
    context: ExecutionContext,
  ): Promise<void> {
    const required = this.reflector.getAllAndOverride<PlatformPermission[]>(
      PLATFORM_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return;
    if (required.length === 0) {
      throw new ForbiddenException(
        'Platform permission configuration is empty',
      );
    }

    const request = context.switchToHttp().getRequest<{
      user?: { id?: unknown };
    }>();
    const userId = request.user?.id;
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new UnauthorizedException('Authentication required');
    }

    const allowed = await this.permissionsService.hasPlatformPermissions(
      userId,
      required,
    );
    if (!allowed) {
      throw new ForbiddenException('Insufficient platform permissions');
    }
  }

  private async checkOrganizationPermissions(
    context: ExecutionContext,
  ): Promise<void> {
    const requirement =
      this.reflector.getAllAndOverride<OrganizationPermissionRequirement>(
        ORGANIZATION_PERMISSIONS_KEY,
        [context.getHandler(), context.getClass()],
      );
    if (!requirement) return;
    const { permissions: required, organizationIdParam } = requirement;
    if (required.length === 0) {
      throw new ForbiddenException(
        'Organization permission configuration is empty',
      );
    }

    const request = context.switchToHttp().getRequest<{
      user?: { id?: unknown };
      params?: Record<string, unknown>;
    }>();
    const userId = request.user?.id;
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new UnauthorizedException('Authentication required');
    }
    // Guards run before parameter pipes, so validate before querying Prisma.
    const organizationId = request.params?.[organizationIdParam];
    if (typeof organizationId !== 'string' || !isUUID(organizationId)) {
      throw new BadRequestException(
        'A valid organizationId route parameter is required',
      );
    }

    const allowed = await this.permissionsService.hasOrganizationPermissions(
      userId,
      organizationId,
      required,
    );
    if (!allowed) {
      throw new ForbiddenException(
        'Insufficient organization permissions or membership',
      );
    }
  }
}
