import type { Prisma } from '@/generated/prisma/client.js';
import type { ListInvitationsQueryDto } from '../dto/list-invitations-query.dto.js';

export const INVITATION_EXPIRY_DAYS = 7;
export const RESEND_COOLDOWN_MS = 60_000;
export const MAX_RESEND_COUNT = 5;

export const INVITATION_LIST_SELECT = {
  id: true,
  organizationId: true,
  email: true,
  status: true,
  expiresAt: true,
  invitedById: true,
  createdAt: true,
  resendCount: true,
  lastRequestedAt: true,
  deliveryStatus: true,
  sentAt: true,
} satisfies Prisma.OrganizationInvitationSelect;

type InvitationStatus = NonNullable<ListInvitationsQueryDto['status']>;

/** Statuses whose meaning depends on the clock rather than the stored column. */
export const INVITATION_STATUS_FILTERS: Partial<
  Record<
    InvitationStatus,
    (now: Date) => Prisma.OrganizationInvitationWhereInput
  >
> = {
  EXPIRED: (now) => ({
    OR: [{ status: 'EXPIRED' }, { status: 'PENDING', expiresAt: { lte: now } }],
  }),
  PENDING: (now) => ({
    status: 'PENDING',
    expiresAt: { gt: now },
  }),
};
