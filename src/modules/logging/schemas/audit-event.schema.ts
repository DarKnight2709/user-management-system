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
