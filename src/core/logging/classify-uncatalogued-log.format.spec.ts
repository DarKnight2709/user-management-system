import { describe, expect, it } from 'vitest';
import { classifyUncataloguedLogs } from './classify-uncatalogued-log.format.js';

describe('classifyUncataloguedLogs', () => {
  const classify = classifyUncataloguedLogs().transform as (
    info: Record<string, unknown>,
    options?: unknown,
  ) => Record<string, unknown>;

  it('labels an uncatalogued framework record', () => {
    const result = classify({
      level: 'info',
      message: 'Mapped {/users, GET} route',
      context: 'RoutesResolver',
    });

    expect(result).toMatchObject({
      category: 'application',
      event: 'framework.log',
      context: 'RoutesResolver',
    });
  });

  it('preserves categories and event names supplied by LoggingService', () => {
    const result = classify({
      level: 'info',
      message: 'Login succeeded',
      category: 'security',
      event: 'auth.login.succeeded',
    });

    expect(result).toMatchObject({
      category: 'security',
      event: 'auth.login.succeeded',
    });
  });

  it('fills only whichever classification field is missing', () => {
    const result = classify({
      level: 'warn',
      message: 'Application warning',
      category: 'application',
    });

    expect(result).toMatchObject({
      category: 'application',
      event: 'framework.log',
    });
  });
});
