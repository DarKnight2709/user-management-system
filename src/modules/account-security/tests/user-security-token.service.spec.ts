import { createHash } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client.js';
import {
  PASSWORD_RESET_TOKEN_LIFETIME_MS,
  SECURITY_TOKEN_PATTERN,
} from '../constants/account-security.constant.js';
import { UserSecurityTokenService } from '../services/user-security-token.service.js';

const SECRET = 'a'.repeat(64);
const ROW_ID = '123e4567-e89b-42d3-a456-426614174001';
const USER_ID = '123e4567-e89b-42d3-a456-426614174002';

/**
 * Reads only the values given here. A real ConfigService falls back to
 * process.env for a missing value, so a developer's own .env would leak into
 * the "missing" cases below.
 */
const serviceWith = (values: Record<string, unknown> = {}) => {
  const settings: Record<string, unknown> = {
    ACCOUNT_TOKEN_SECRET: SECRET,
    FRONTEND_URL: 'https://app.example.com',
    ...values,
  };
  return new UserSecurityTokenService({
    get: (key: string) => settings[key],
  } as unknown as ConfigService);
};

describe('UserSecurityTokenService', () => {
  describe('tokenFor', () => {
    it('is the same for the same row', () => {
      const service = serviceWith();

      expect(service.tokenFor('PASSWORD_RESET', ROW_ID)).toBe(
        service.tokenFor('PASSWORD_RESET', ROW_ID),
      );
    });

    it('differs from row to row', () => {
      const service = serviceWith();

      expect(service.tokenFor('PASSWORD_RESET', ROW_ID)).not.toBe(
        service.tokenFor('PASSWORD_RESET', USER_ID),
      );
    });

    it('depends on the secret', () => {
      expect(serviceWith().tokenFor('PASSWORD_RESET', ROW_ID)).not.toBe(
        serviceWith({ ACCOUNT_TOKEN_SECRET: 'b'.repeat(64) }).tokenFor(
          'PASSWORD_RESET',
          ROW_ID,
        ),
      );
    });

    it('matches the format the API accepts', () => {
      expect(serviceWith().tokenFor('PASSWORD_RESET', ROW_ID)).toMatch(
        SECURITY_TOKEN_PATTERN,
      );
    });

    it.each([
      ['missing', undefined],
      ['too short', 'a'.repeat(63)],
    ])('is unavailable when the secret is %s', (_, secret) => {
      expect(() =>
        serviceWith({ ACCOUNT_TOKEN_SECRET: secret }).tokenFor(
          'PASSWORD_RESET',
          ROW_ID,
        ),
      ).toThrow('Account token configuration is unavailable');
    });
  });

  describe('hash', () => {
    it('is the SHA-256 of the token', () => {
      expect(serviceWith().hash('token')).toBe(
        createHash('sha256').update('token').digest('hex'),
      );
    });
  });

  describe('linkFor', () => {
    const link = () => new URL(serviceWith().linkFor('PASSWORD_RESET', ROW_ID));

    it('points at the reset page of the frontend', () => {
      expect(`${link().origin}${link().pathname}`).toBe(
        'https://app.example.com/reset-password',
      );
    });

    it('carries the token in the fragment, not the query', () => {
      expect(link().search).toBe('');
    });

    it('puts the matching token in the fragment', () => {
      expect(link().hash).toBe(
        `#token=${serviceWith().tokenFor('PASSWORD_RESET', ROW_ID)}`,
      );
    });

    it('ignores trailing slashes on the frontend address', () => {
      const url = serviceWith({
        FRONTEND_URL: 'https://app.example.com//',
      }).linkFor('PASSWORD_RESET', ROW_ID);

      expect(url.startsWith('https://app.example.com/reset-password#')).toBe(
        true,
      );
    });

    it('is unavailable without a frontend address', () => {
      expect(() =>
        serviceWith({ FRONTEND_URL: undefined }).linkFor(
          'PASSWORD_RESET',
          ROW_ID,
        ),
      ).toThrow('Account link configuration is unavailable');
    });
  });

  describe('issue', () => {
    const setup = () => {
      const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
      const create = vi.fn().mockResolvedValue({});
      const manager = {
        userSecurityToken: { deleteMany, create },
      } as unknown as Prisma.TransactionClient;
      return { manager, deleteMany, create };
    };

    it('replaces the earlier token of the same type', async () => {
      const { manager, deleteMany } = setup();

      await serviceWith().issue(
        manager,
        USER_ID,
        'PASSWORD_RESET',
        PASSWORD_RESET_TOKEN_LIFETIME_MS,
      );

      expect(deleteMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, type: 'PASSWORD_RESET' },
      });
    });

    it('stores only the hash of the token it will send', async () => {
      const { manager, create } = setup();
      const service = serviceWith();

      const { id } = await service.issue(
        manager,
        USER_ID,
        'PASSWORD_RESET',
        PASSWORD_RESET_TOKEN_LIFETIME_MS,
      );

      expect(create.mock.calls[0][0].data).toMatchObject({
        id,
        userId: USER_ID,
        type: 'PASSWORD_RESET',
        tokenHash: service.hash(service.tokenFor('PASSWORD_RESET', id)),
      });
    });

    it('never stores the token itself', async () => {
      const { manager, create } = setup();
      const service = serviceWith();

      const { id } = await service.issue(
        manager,
        USER_ID,
        'PASSWORD_RESET',
        PASSWORD_RESET_TOKEN_LIFETIME_MS,
      );

      expect(JSON.stringify(create.mock.calls)).not.toContain(
        service.tokenFor('PASSWORD_RESET', id),
      );
    });

    it('expires after the lifetime', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
      const { manager } = setup();

      const { expiresAt } = await serviceWith().issue(
        manager,
        USER_ID,
        'PASSWORD_RESET',
        PASSWORD_RESET_TOKEN_LIFETIME_MS,
      );
      vi.useRealTimers();

      expect(expiresAt.toISOString()).toBe('2026-06-15T12:30:00.000Z');
    });

    it('deletes the old token before creating the new one', async () => {
      const { manager, deleteMany, create } = setup();

      await serviceWith().issue(
        manager,
        USER_ID,
        'PASSWORD_RESET',
        PASSWORD_RESET_TOKEN_LIFETIME_MS,
      );

      expect(deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
        create.mock.invocationCallOrder[0],
      );
    });
  });
});
