import type { OrganizationInvitation } from '@/generated/prisma/client.js';
import type { InvitationEmailService } from '../services/invitation-email.service.js';

/**
 * Queues delivery outside any database transaction. The result only says whether
 * the job was accepted by the queue, never that an email was sent.
 */
export async function queueInvitationEmail(
  email: InvitationEmailService,
  invitation: OrganizationInvitation,
): Promise<{ emailQueued: boolean }> {
  const emailQueued = await email.enqueue(
    invitation.id,
    invitation.deliveryVersion,
  );
  return { emailQueued };
}
