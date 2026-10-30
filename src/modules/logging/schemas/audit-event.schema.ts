import Joi from 'joi';
import type { AuditEventInput } from '../types/audit-event.types.js';

const idSchema = Joi.string().uuid().required();

const organizationMemberRoleAuditEventSchema = Joi.object({
  actor: Joi.object({
    type: Joi.string().valid('USER').required(),
    id: idSchema,
  }).required(),
  target: Joi.object({
    type: Joi.string().valid('ORGANIZATION_MEMBER').required(),
    id: idSchema,
  }).required(),
  organizationId: idSchema,
  payload: Joi.object({
    memberUserId: idSchema,
    roleId: idSchema,
    // Matches CreateOrganizationRoleDto: uppercase letters, digits, underscores.
    roleName: Joi.string()
      .pattern(/^[A-Z][A-Z0-9_]{0,49}$/)
      .required(),
  }).required(),
  requestContext: Joi.object({ requestId: idSchema }).required(),
});

const roleNameSchema = Joi.string()
  .pattern(/^[A-Z][A-Z0-9_]{0,49}$/)
  .required();

const rolePermissionsSchema = Joi.array()
  .items(
    Joi.object({
      id: idSchema,
      resource: Joi.string()
        .pattern(/^[A-Z][A-Z0-9_]{0,63}$/)
        .required(),
      action: Joi.string()
        .pattern(/^[a-z][a-z0-9-]{0,63}$/)
        .required(),
    }).required(),
  )
  .max(64)
  .unique('id')
  .required();

const organizationRoleSnapshotSchema = Joi.object({
  name: roleNameSchema,
  permissions: rolePermissionsSchema,
}).required();

const organizationRoleAuditEventSchema = Joi.object({
  actor: Joi.object({
    type: Joi.string().valid('USER').required(),
    id: idSchema,
  }).required(),
  target: Joi.object({
    type: Joi.string().valid('ROLE').required(),
    id: idSchema,
  }).required(),
  organizationId: idSchema,
  requestContext: Joi.object({ requestId: idSchema }).required(),
});

export const auditEventSchema = Joi.alternatives<AuditEventInput>()
  .try(
    organizationMemberRoleAuditEventSchema.keys({
      action: Joi.string()
        .valid('organization.member_role.assigned')
        .required(),
    }),
    organizationMemberRoleAuditEventSchema.keys({
      action: Joi.string().valid('organization.member_role.revoked').required(),
    }),
    organizationRoleAuditEventSchema.keys({
      action: Joi.string().valid('organization.role.created').required(),
      payload: organizationRoleSnapshotSchema,
    }),
    organizationRoleAuditEventSchema.keys({
      action: Joi.string().valid('organization.role.updated').required(),
      payload: Joi.object({
        before: organizationRoleSnapshotSchema,
        after: organizationRoleSnapshotSchema,
      }).required(),
    }),
    organizationRoleAuditEventSchema.keys({
      action: Joi.string().valid('organization.role.deleted').required(),
      payload: organizationRoleSnapshotSchema,
    }),
  )
  .required()
  .prefs({
    convert: false,
    abortEarly: true,
    stripUnknown: { objects: true },
  });

export function parseAuditEvent(input: unknown): AuditEventInput {
  const { error, value } = auditEventSchema.validate(input);
  if (error) {
    // Validation errors may contain event values; never forward them to logs.
    throw new Error('Invalid audit event');
  }
  return value;
}
