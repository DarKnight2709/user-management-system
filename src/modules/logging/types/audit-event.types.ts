export type AuditRequestContext = {
  requestId: string;
};

type UserAuditActor = { type: 'USER'; id: string };

type AnonymousUserRegistrationAuditEvent = {
  actor: { type: 'ANONYMOUS' };
  target: { type: 'USER'; id: string };
  requestContext: AuditRequestContext;
};

type UserAuditEvent = {
  actor: UserAuditActor;
  target: { type: 'USER'; id: string };
  requestContext: AuditRequestContext;
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

type OrganizationAuditEvent = {
  actor: {
    type: 'USER';
    id: string;
  };
  target: {
    type: 'ORGANIZATION';
    id: string;
  };
  organizationId: string;
  requestContext: AuditRequestContext;
};

type OrganizationMemberAuditEvent = {
  actor: {
    type: 'USER';
    id: string;
  };
  target: {
    type: 'ORGANIZATION_MEMBER';
    id: string;
  };
  organizationId: string;
  payload: { memberUserId: string };
  requestContext: AuditRequestContext;
};

type OrganizationInvitationAuditEvent = {
  actor: {
    type: 'USER';
    id: string;
  };
  target: {
    type: 'ORGANIZATION_INVITATION';
    id: string;
  };
  organizationId: string;
  requestContext: AuditRequestContext;
};

export type AuditEventInput =
  | (AnonymousUserRegistrationAuditEvent & {
      action: 'user.registered';
      payload: { registrationMethod: 'PASSWORD' };
    })
  | (UserAuditEvent & {
      action: 'user.profile.updated';
      payload: {
        changedFields: (
          'username' | 'email' | 'firstName' | 'lastName' | 'birthDate'
        )[];
      };
    })
  | (UserAuditEvent & {
      action: 'user.deleted';
      payload: { selfDeletion: boolean; revokedRefreshTokenCount: number };
    })
  | (UserAuditEvent & {
      action: 'user.password.changed';
      payload: { revokedRefreshTokenCount: number };
    })
  | (UserAuditEvent & {
      action: 'user.avatar.updated';
      payload: { change: 'ADDED' | 'REPLACED' };
    })
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
    })
  | (OrganizationAuditEvent & {
      action: 'organization.created';
      payload: { name: string; slug: string; ownerId: string };
    })
  | (OrganizationAuditEvent & {
      action: 'organization.updated';
      payload: { before: { name: string }; after: { name: string } };
    })
  | (OrganizationAuditEvent & {
      action: 'organization.deleted';
      payload: {
        name: string;
        slug: string;
        ownerId: string;
        revokedPendingInvitationCount: number;
      };
    })
  | (OrganizationAuditEvent & {
      action: 'organization.ownership.transferred';
      payload: {
        previousOwnerId: string;
        newOwnerId: string;
        previousOwnerMembershipId: string;
      };
    })
  | (OrganizationMemberAuditEvent & {
      action: 'organization.member.removed' | 'organization.member.left';
    })
  | (OrganizationInvitationAuditEvent & {
      action: 'organization.invitation.created';
      payload: {
        expiresAt: string;
        expiredInvitationCount: number;
        revokedStaleInvitationCount: number;
      };
    })
  | (OrganizationInvitationAuditEvent & {
      action: 'organization.invitation.resend_requested';
      payload: { deliveryVersion: number; resendCount: number };
    })
  | (OrganizationInvitationAuditEvent & {
      action: 'organization.invitation.revoked';
      payload: { deliveryVersion: number };
    })
  | (OrganizationInvitationAuditEvent & {
      action: 'organization.invitation.accepted';
      payload: {
        membershipId: string;
        membershipReactivated: boolean;
        previousRoleIds: string[];
        memberRoleId: string;
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
