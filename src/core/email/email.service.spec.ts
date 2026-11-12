import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { EmailService } from './email.service.js';

describe('EmailService', () => {
  const sendMail = vi.fn();
  let service: EmailService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new EmailService(
      new ConfigService({
        SMTP_HOST: 'smtp.invalid',
        SMTP_PORT: 587,
        SMTP_FROM: 'sender@example.com',
        SMTP_USER: '',
        SMTP_SECURE: false,
      }),
    );
    Reflect.set(service, 'transport', { sendMail, close: vi.fn() });
  });

  it('sends a plain text invitation and requires an accepted recipient', async () => {
    sendMail.mockResolvedValue({ accepted: ['member@example.com'] });

    await service.sendInvitationEmail({
      to: 'member@example.com',
      organizationName: 'Example',
      inviteLink: 'https://frontend.invalid/invitations/accept#token=x',
      expiresAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'sender@example.com',
        to: 'member@example.com',
        disableFileAccess: true,
        disableUrlAccess: true,
        text: expect.stringContaining('Expires: 2026-01-01T00:00:00.000Z'),
      }),
    );
  });

  it('rejects a provider response without accepted recipients', async () => {
    sendMail.mockResolvedValue({ accepted: [] });

    await expect(
      service.sendInvitationEmail({
        to: 'member@example.com',
        organizationName: 'Example',
        inviteLink: 'https://frontend.invalid/invitations/accept#token=x',
        expiresAt: new Date(),
      }),
    ).rejects.toThrow('Recipient was not accepted');
  });

  describe('password reset email', () => {
    const message = {
      to: 'user@example.com',
      resetLink: 'https://frontend.invalid/reset-password#token=abc',
      expiresAt: new Date('2026-01-01T00:30:00.000Z'),
    };

    it('is plain text with the link and its expiry', async () => {
      sendMail.mockResolvedValue({ accepted: ['user@example.com'] });

      await service.sendPasswordResetEmail(message);

      expect(sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'sender@example.com',
          to: 'user@example.com',
          subject: 'Reset your password',
          disableFileAccess: true,
          disableUrlAccess: true,
          text: expect.stringContaining(message.resetLink),
        }),
      );
    });

    it('states when the link expires', async () => {
      sendMail.mockResolvedValue({ accepted: ['user@example.com'] });

      await service.sendPasswordResetEmail(message);

      expect(sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('2026-01-01T00:30:00.000Z'),
        }),
      );
    });

    it('tells the reader to ignore it when they did not ask', async () => {
      sendMail.mockResolvedValue({ accepted: ['user@example.com'] });

      await service.sendPasswordResetEmail(message);

      expect(sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('If you did not ask for this'),
        }),
      );
    });

    it('rejects a provider response without accepted recipients', async () => {
      sendMail.mockResolvedValue({ accepted: [] });

      await expect(service.sendPasswordResetEmail(message)).rejects.toThrow(
        'Recipient was not accepted',
      );
    });
  });

  it('closes the SMTP transport during application shutdown', () => {
    const close = vi.fn();
    Reflect.set(service, 'transport', { sendMail, close });

    service.onApplicationShutdown();

    expect(close).toHaveBeenCalledOnce();
  });
});
