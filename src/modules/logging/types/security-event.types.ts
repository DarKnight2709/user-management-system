import type { AuthSecurityEventInput } from './auth-event.types.js';
import type { SecurityRequestContext } from './security-request-context.types.js';

export type AuthorizationPermission = {
  resource: string;
  action: string;
};

export type AuthorizationDeniedEventInput =
  | {
      action: 'authorization.denied';
      actor: { type: 'USER'; id: string };
      scope: 'PLATFORM';
      reasonCode: 'INSUFFICIENT_PLATFORM_PERMISSION';
      requiredPermissions: AuthorizationPermission[];
      requestContext: SecurityRequestContext;
    }
  | {
      action: 'authorization.denied';
      actor: { type: 'USER'; id: string };
      scope: 'ORGANIZATION';
      organizationId: string;
      reasonCode: 'INSUFFICIENT_ORGANIZATION_PERMISSION_OR_MEMBERSHIP';
      requiredPermissions: AuthorizationPermission[];
      requestContext: SecurityRequestContext;
    };

export type SecurityEventInput =
  | AuthSecurityEventInput
  | AuthorizationDeniedEventInput;
