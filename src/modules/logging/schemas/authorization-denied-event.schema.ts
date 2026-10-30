import Joi from 'joi';
import { organizationPermissions } from '@/common/constants/organization-permissions.constant.js';
import type { AuthorizationDeniedEventInput } from '../types/security-event.types.js';
import { securityRequestContextSchema } from './security-request-context.schema.js';

const idSchema = Joi.string().uuid().required();

const platformPermissionKeys = new Set([
  'USER:read',
  'USER:delete',
  'ORGANIZATION:delete',
]);
const organizationPermissionKeys = new Set(
  organizationPermissions.map(({ resource, action }) => `${resource}:${action}`),
);

function permissionSchema(allowedPermissions: ReadonlySet<string>) {
  return Joi.object({
    resource: Joi.string().max(64).required(),
    action: Joi.string().max(64).required(),
  })
    .required()
    .custom((permission: { resource: string; action: string }, helpers) => {
      if (!allowedPermissions.has(`${permission.resource}:${permission.action}`)) {
        return helpers.error('any.invalid');
      }
      return permission;
    });
}

const requiredPermissions = (allowed: ReadonlySet<string>) =>
  Joi.array().items(permissionSchema(allowed)).min(1).max(16).required();

export const authorizationDeniedEventSchema =
  Joi.alternatives<AuthorizationDeniedEventInput>()
    .try(
      Joi.object({
        action: Joi.string().valid('authorization.denied').required(),
        actor: Joi.object({
          type: Joi.string().valid('USER').required(),
          id: idSchema,
        }).required(),
        scope: Joi.string().valid('PLATFORM').required(),
        reasonCode: Joi.string()
          .valid('INSUFFICIENT_PLATFORM_PERMISSION')
          .required(),
        requiredPermissions: requiredPermissions(platformPermissionKeys),
        requestContext: securityRequestContextSchema,
      }),
      Joi.object({
        action: Joi.string().valid('authorization.denied').required(),
        actor: Joi.object({
          type: Joi.string().valid('USER').required(),
          id: idSchema,
        }).required(),
        scope: Joi.string().valid('ORGANIZATION').required(),
        organizationId: idSchema,
        reasonCode: Joi.string()
          .valid('INSUFFICIENT_ORGANIZATION_PERMISSION_OR_MEMBERSHIP')
          .required(),
        requiredPermissions: requiredPermissions(organizationPermissionKeys),
        requestContext: securityRequestContextSchema,
      }),
    )
    .required()
    .prefs({
      convert: false,
      abortEarly: true,
      stripUnknown: { objects: true },
    });

export function parseAuthorizationDeniedEvent(
  input: unknown,
): AuthorizationDeniedEventInput {
  const { error, value } = authorizationDeniedEventSchema.validate(input);
  if (error) {
    throw new Error('Invalid authorization event');
  }
  return value;
}
