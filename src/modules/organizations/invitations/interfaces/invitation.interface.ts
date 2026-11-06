import type { Prisma } from '@/generated/prisma/client.js';
import type { INVITATION_LIST_SELECT } from '../constants/invitation.constant.js';
import type { ListInvitationsQueryDto } from '../dto/list-invitations-query.dto.js';

export type PreviousMembership = {
  id: string;
  status: string;
  deletedAt: Date | null;
} | null;

export type ActiveInvitationUser = {
  id: string;
  email: string;
};

export type CreateInvitationInput = {
  actorId: string;
  organizationId: string;
  email: string;
  invitationId: string;
  tokenHash: string;
};

/** Identifies one invitation inside one organization for resend/copy/revoke. */
export type InvitationActionInput = {
  actorId: string;
  organizationId: string;
  invitationId: string;
};

export type ListInvitationsInput = {
  actorId: string;
  organizationId: string;
  page: number;
  limit: number;
  email?: string;
  status?: ListInvitationsQueryDto['status'];
};

export type InvitationListRecord = Prisma.OrganizationInvitationGetPayload<{
  select: typeof INVITATION_LIST_SELECT;
}>;

export type JoinMemberInput = {
  organizationId: string;
  userId: string;
  roleId: string;
  previousMembership: PreviousMembership;
};
