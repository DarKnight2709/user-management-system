import { describe, expect, it } from 'vitest';
import { format } from 'winston';
import { utilities } from 'nest-winston';
import { redactSensitiveData } from './redact-log.format.js';

describe('Winston redaction formatter', () => {
  it.each(['json', 'pretty'])(
    'redacts nested secrets before %s output without losing safe fields',
    (output) => {
      const source = {
        level: 'info',
        message: 'Authentication attempted',
        requestId: 'fixture-request',
        context: 'FixtureService',
        password: 'private-password',
        user: { name: 'alice', refreshToken: 'private-token' },
        sessions: [{ authorization: 'private-authorization' }],
        file: Buffer.from('private-file'),
        error: new Error('private-error'),
        count: 123n,
        [Symbol.for('level')]: 'info',
      };
      const pipeline = format.combine(
        redactSensitiveData(),
        format.timestamp(),
        output === 'json'
          ? format.json()
          : utilities.format.nestLike('Fixture', {
              colors: true,
              prettyPrint: true,
            }),
      );
      const record = pipeline.transform(source, pipeline.options);
      if (!record) throw new Error('Safe record was unexpectedly filtered');
      const rendered = String(record[Symbol.for('message')]);
      expect(rendered).not.toContain('private-');
      expect(rendered).toContain('[REDACTED]');
      expect(rendered).toContain('fixture-request');
      expect(rendered).toContain('FixtureService');
      expect(record[Symbol.for('level')]).toBe('info');
      expect(source.user.refreshToken).toBe('[REDACTED]');
      if (output === 'json') {
        expect(JSON.parse(rendered)).toMatchObject({
          level: 'info',
          message: 'Authentication attempted',
          user: { name: 'alice', refreshToken: '[REDACTED]' },
          count: '123',
        });
      }
    },
  );

  it('handles cyclic metadata and repeated objects without exposing the originals', () => {
    const shared = { password: 'private-password', name: 'alice' };
    const metadata: Record<string, unknown> = { first: shared, second: shared };
    metadata.self = metadata;
    const pipeline = format.combine(redactSensitiveData(), format.json());
    const record = pipeline.transform(
      {
        level: 'info',
        message: 'Fixture',
        metadata,
        [Symbol.for('level')]: 'info',
      },
      pipeline.options,
    );
    if (!record) throw new Error('Safe record was unexpectedly filtered');
    const rendered = JSON.parse(String(record[Symbol.for('message')]));
    expect(rendered.metadata).toEqual({
      first: { password: '[REDACTED]', name: 'alice' },
      second: { password: '[REDACTED]', name: 'alice' },
      self: '[CIRCULAR]',
    });
    expect(shared.password).toBe('private-password');
  });
});
