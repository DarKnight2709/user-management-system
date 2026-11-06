import { describe, expect, it, vi } from 'vitest';
import type { InvitationEmailService } from '../services/invitation-email.service.js';
import { queueInvitationEmail } from '../utils/invitation-email.util.js';

const invitation = { id: 'invitation-id', deliveryVersion: 4 } as never;

describe('queueInvitationEmail', () => {
  it('enqueues the invitation at its current delivery version', async () => {
    const email = { enqueue: vi.fn().mockResolvedValue(true) };

    await queueInvitationEmail(
      email as unknown as InvitationEmailService,
      invitation,
    );

    expect(email.enqueue).toHaveBeenCalledWith('invitation-id', 4);
  });

  it.each([true, false])(
    'reports queue acceptance (%s) without claiming delivery',
    async (queued) => {
      const email = { enqueue: vi.fn().mockResolvedValue(queued) };

      const result = await queueInvitationEmail(
        email as unknown as InvitationEmailService,
        invitation,
      );

      expect(result).toEqual({ emailQueued: queued });
    },
  );
});
