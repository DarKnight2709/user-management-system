import { describe, expect, it, vi } from 'vitest';
import {
  InvitationAcceptanceController,
  InvitationsController,
} from '../invitations.controller.js';

describe('Invitation controllers', () => {
  it('delegates invitation management operations with route values', async () => {
    const invitations = {
      create: vi.fn(),
      list: vi.fn(),
      resend: vi.fn(),
      copyLink: vi.fn(),
      revoke: vi.fn(),
    };
    const controller = new InvitationsController(invitations as never);
    const dto = { email: 'member@example.com' };

    await controller.create('actor', 'organization', dto as never);
    await controller.list('actor', 'organization', { page: 1 } as never);
    await controller.resend('actor', 'organization', 'invitation');
    await controller.link('actor', 'organization', 'invitation');
    await controller.revoke('actor', 'organization', 'invitation');

    expect(invitations.create).toHaveBeenCalledWith(
      'actor',
      'organization',
      dto,
    );
    expect(invitations.list).toHaveBeenCalledWith('actor', 'organization', {
      page: 1,
    });
    expect(invitations.resend).toHaveBeenCalledWith(
      'actor',
      'organization',
      'invitation',
    );
    expect(invitations.copyLink).toHaveBeenCalledWith(
      'actor',
      'organization',
      'invitation',
    );
    expect(invitations.revoke).toHaveBeenCalledWith(
      'actor',
      'organization',
      'invitation',
    );
  });

  it('passes only the token to acceptance service', async () => {
    const invitations = { accept: vi.fn() };
    const controller = new InvitationAcceptanceController(invitations as never);

    await controller.accept('actor', { token: 'token' });

    expect(invitations.accept).toHaveBeenCalledWith('actor', 'token');
  });
});
