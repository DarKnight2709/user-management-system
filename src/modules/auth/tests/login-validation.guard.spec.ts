import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  EMAIL_MAX_LENGTH,
  LOGIN_PASSWORD_MAX_BYTES,
} from '../constants/auth.constant.js';
import { LoginValidationGuard } from '../guards/login-validation.guard.js';

const VALID_PASSWORD = 'correct-password-123';

function contextFor(request: { body?: unknown }): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/**
 * Structurally valid address of the given total length (64-character local part
 * and labels of at most 63), so only its length decides whether it is accepted.
 */
function emailOfLength(length: number): string {
  const localPart = 'a'.repeat(64);
  const fullLabel = 'b'.repeat(63);
  const lastLabelLength =
    length -
    localPart.length -
    '@'.length -
    2 * (fullLabel.length + '.'.length);
  return `${localPart}@${fullLabel}.${fullLabel}.${'c'.repeat(lastLabelLength)}`;
}

describe('LoginValidationGuard', () => {
  const guard = new LoginValidationGuard();

  describe('valid bodies', () => {
    it('lets the request through', async () => {
      const request = {
        body: { email: 'alice@example.com', password: VALID_PASSWORD },
      };

      await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    });

    it('trims and lowercases the email for the strategy', async () => {
      const request = {
        body: { email: '  Alice@Example.COM ', password: VALID_PASSWORD },
      };

      await guard.canActivate(contextFor(request));

      expect(request.body).toEqual({
        email: 'alice@example.com',
        password: VALID_PASSWORD,
      });
    });

    it('hands the strategy a plain object, not a DTO instance', async () => {
      const request = {
        body: { email: 'alice@example.com', password: VALID_PASSWORD },
      };

      await guard.canActivate(contextFor(request));

      expect(Object.getPrototypeOf(request.body)).toBe(Object.prototype);
    });

    it.each([
      [
        'an email of exactly the maximum length',
        emailOfLength(EMAIL_MAX_LENGTH),
        VALID_PASSWORD,
      ],
      ['a one-byte password', 'alice@example.com', 'x'],
      [
        'a password of exactly the maximum size',
        'alice@example.com',
        'x'.repeat(LOGIN_PASSWORD_MAX_BYTES),
      ],
    ])('accepts %s', async (_, email, password) => {
      await expect(
        guard.canActivate(contextFor({ body: { email, password } })),
      ).resolves.toBe(true);
    });
  });

  describe('invalid bodies', () => {
    it.each([
      ['a numeric email', { email: 12345, password: VALID_PASSWORD }],
      ['an object email', { email: { a: 1 }, password: VALID_PASSWORD }],
      ['a numeric password', { email: 'alice@example.com', password: 12345 }],
      [
        'an object password',
        { email: 'alice@example.com', password: { a: 1 } },
      ],
      ['an invalid email', { email: 'not-an-email', password: 'x' }],
      ['a missing password', { email: 'alice@example.com' }],
      ['an empty password', { email: 'alice@example.com', password: '' }],
      ['an empty body', {}],
      ['no body', undefined],
      ['an array body', [{ email: 'alice@example.com', password: 'x' }]],
      ['a string body', 'email=alice@example.com'],
      [
        'an unexpected field',
        { email: 'alice@example.com', password: 'x', role: 'admin' },
      ],
      [
        'an email one character over the maximum',
        { email: emailOfLength(EMAIL_MAX_LENGTH + 1), password: 'x' },
      ],
      [
        'a password one byte over the maximum',
        {
          email: 'alice@example.com',
          password: 'x'.repeat(LOGIN_PASSWORD_MAX_BYTES + 1),
        },
      ],
    ])('rejects %s with 422', async (_, body) => {
      await expect(
        guard.canActivate(contextFor({ body })),
      ).rejects.toMatchObject({ status: 422 });
    });

    it('leaves a rejected body untouched', async () => {
      const body = { email: 12345, password: 'x' };
      const request = { body };

      await guard.canActivate(contextFor(request)).catch(() => {
        // expected rejection
      });

      expect(request.body).toBe(body);
    });

    it('uses the shared validation error format', async () => {
      await expect(
        guard.canActivate(
          contextFor({ body: { email: 12345, password: 'x' } }),
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          message: 'Invalid Data',
          errorType: 'ValidationError',
        }),
      });
    });
  });
});
