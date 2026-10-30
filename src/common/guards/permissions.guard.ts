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
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import {
  PLATFORM_PERMISSIONS_KEY,
  type PlatformPermission,
} from '../decorators/require-platform-permissions.decorator.js';
import {
  ORGANIZATION_PERMISSIONS_KEY,
  type OrganizationPermissionRequirement,
} from '../decorators/require-organization-permissions.decorator.js';

import { PermissionsService } from '@/common/services/permissions.service.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import type { AuthorizationDeniedEventInput } from '@/modules/logging/types/security-event.types.js';
import { requestContext } from '@/core/logging/request-context.js';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,

    private readonly permissionsService: PermissionsService,

    private readonly logging: LoggingService,
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

    const request = context.switchToHttp().getRequest<Request & {
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
      this.logAuthorizationDenial(
        {
          action: 'authorization.denied',
          actor: { type: 'USER', id: userId },
          scope: 'PLATFORM',
          reasonCode: 'INSUFFICIENT_PLATFORM_PERMISSION',
          requiredPermissions: required.map(({ resource, action }) => ({
            resource,
            action,
          })),
        },
        request,
      );
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

    const request = context.switchToHttp().getRequest<Request & {
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
      this.logAuthorizationDenial(
        {
          action: 'authorization.denied',
          actor: { type: 'USER', id: userId },
          scope: 'ORGANIZATION',
          organizationId,
          reasonCode:
            'INSUFFICIENT_ORGANIZATION_PERMISSION_OR_MEMBERSHIP',
          requiredPermissions: required.map(({ resource, action }) => ({
            resource,
            action,
          })),
        },
        request,
      );
      throw new ForbiddenException(
        'Insufficient organization permissions or membership',
      );
    }
  }

  private logAuthorizationDenial(
    event: Omit<
      Extract<AuthorizationDeniedEventInput, { scope: 'PLATFORM' }>,
      'requestContext'
    >
      | Omit<
          Extract<AuthorizationDeniedEventInput, { scope: 'ORGANIZATION' }>,
          'requestContext'
        >,
    request: Request,
  ): void {
    this.logging.security({
      ...event,
      requestContext: {
        requestId: requestContext.getStore()?.requestId ?? randomUUID(),
        sourceIp: request.ip,
        userAgent: request.get('user-agent'),
      },
    });
  }
}
