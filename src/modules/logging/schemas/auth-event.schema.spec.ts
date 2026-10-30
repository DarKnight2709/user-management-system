import { describe, expect, it } from 'vitest';
import { parseAuthSecurityEvent } from './auth-event.schema.js';

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const actorId = '123e4567-e89b-42d3-a456-426614174001';
const familyId = '123e4567-e89b-42d3-a456-426614174002';

function loginEvent() {
  return {
    action: 'auth.login.succeeded',
    actor: { type: 'USER', id: actorId },
    authMethod: 'PASSWORD',
    sessionRef: familyId,
    requestContext: { requestId },
  };
}

describe('Authentication event validation', () => {
  it('removes unknown fields at every level without mutating the input', () => {
    const input = {
      ...loginEvent(),
      password: 'private-password',
      actor: { type: 'USER', id: actorId, token: 'private-token' },
      requestContext: { requestId, authorization: 'private-authorization' },
    };

    expect(parseAuthSecurityEvent(input)).toEqual(loginEvent());
    expect(input.actor.token).toBe('private-token');
  });

  it('accepts rejected credentials without identifying an anonymous actor', () => {
    expect(
      parseAuthSecurityEvent({
        action: 'auth.login.failed',
        actor: { type: 'ANONYMOUS', id: actorId },
        authMethod: 'PASSWORD',
        reasonCode: 'INVALID_CREDENTIALS',
        requestContext: { requestId },
      }),
    ).toEqual({
      action: 'auth.login.failed',
      actor: { type: 'ANONYMOUS' },
      authMethod: 'PASSWORD',
      reasonCode: 'INVALID_CREDENTIALS',
      requestContext: { requestId },
    });
  });

  it.each([
    { action: 'auth.login.error' },
    { authMethod: 'PASSWORD_MFA' },
    { actor: { type: 'ANONYMOUS' } },
    { sessionRef: 'private-refresh-token' },
    { requestContext: { requestId: 'untrusted-request-id' } },
    { requestContext: undefined },
  ])('rejects invalid core fields with a safe error', (fields) => {
    expect(() =>
      parseAuthSecurityEvent({ ...loginEvent(), ...fields }),
    ).toThrow('Invalid authentication event');
  });

  it.each(['203.0.113.1', '2001:db8::1', '::ffff:203.0.113.1'])(
    'preserves the valid IP %s',
    (sourceIp) => {
      const event = parseAuthSecurityEvent({
        ...loginEvent(),
        requestContext: { requestId, sourceIp },
      });
      expect(event.requestContext.sourceIp).toBe(sourceIp);
    },
  );

  it('omits invalid optional context without losing the event', () => {
    const event = parseAuthSecurityEvent({
      ...loginEvent(),
      requestContext: {
        requestId,
        sourceIp: '203.0.113.1, 203.0.113.2',
        userAgent: { token: 'private-token' },
      },
    });

    expect(event.action).toBe('auth.login.succeeded');
    expect(event.requestContext.sourceIp).toBeUndefined();
    expect(event.requestContext.userAgent).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain('private-token');
  });

  it('bounds and sanitizes User-Agent without modifying request identity', () => {
    const event = parseAuthSecurityEvent({
      ...loginEvent(),
      requestContext: { requestId, userAgent: `Browser\r\n${'x'.repeat(600)}` },
    });

    expect(event.requestContext.requestId).toBe(requestId);
    expect(event.requestContext.userAgent?.length).toBeLessThanOrEqual(512);
    expect(event.requestContext.userAgent).not.toMatch(/[\r\n]/);
  });

  it('rejects raw email used as a pseudonymous login identifier', () => {
    expect(() =>
      parseAuthSecurityEvent({
        action: 'auth.login.failed',
        actor: { type: 'ANONYMOUS' },
        authMethod: 'PASSWORD',
        reasonCode: 'INVALID_CREDENTIALS',
        loginIdentifierRef: 'private@example.com',
        requestContext: { requestId },
      }),
    ).toThrow('Invalid authentication event');
  });
});
