export type AuditRequestContext = {
  requestId: string;
};

type OrganizationMemberRoleAuditEvent = {
  actor: {
    type: 'USER';
    id: string;
  };
  target: {
    type: 'ORGANIZATION_MEMBER';
    id: string;
  };
  organizationId: string;
  payload: {
    memberUserId: string;
    roleId: string;
    roleName: string;
  };
  requestContext: AuditRequestContext;
};

type OrganizationRoleSnapshot = {
  name: string;
  permissions: {
    id: string;
    resource: string;
    action: string;
  }[];
};

type OrganizationRoleAuditEvent = {
  actor: {
    type: 'USER';
    id: string;
  };
  target: {
    type: 'ROLE';
    id: string;
  };
  organizationId: string;
  requestContext: AuditRequestContext;
};

export type AuditEventInput =
  | (OrganizationMemberRoleAuditEvent & {
      action: 'organization.member_role.assigned';
    })
  | (OrganizationMemberRoleAuditEvent & {
      action: 'organization.member_role.revoked';
    })
  | (OrganizationRoleAuditEvent & {
      action: 'organization.role.created' | 'organization.role.deleted';
      payload: OrganizationRoleSnapshot;
    })
  | (OrganizationRoleAuditEvent & {
      action: 'organization.role.updated';
      payload: {
        before: OrganizationRoleSnapshot;
        after: OrganizationRoleSnapshot;
      };
    });

export type AuditEventName = AuditEventInput['action'];

export type StoredAuditEvent = AuditEventInput & {
  eventId: string;
  schemaVersion: 1;
  occurredAt: string;
  environment: string;
  category: 'audit';
  outcome: 'SUCCESS';
};
