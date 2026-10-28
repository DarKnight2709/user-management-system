export type AuthEventName = 'auth.login.succeeded' | 'auth.login.failed';

type AuthEventPolicy = {
  schemaVersion: 1;
  category: 'security';
  output: 'winston-console';
  persistToPostgres: false;

  outcome: 'SUCCESS' | 'FAILURE';
  level: 'info' | 'warn';

  emitWhen:
    | 'authentication-completed-and-session-committed'
    | 'authentication-rejected';

  onLoggingFailure: 'preserve-authentication-result';
};

export const AUTH_EVENT_POLICIES = {
  'auth.login.succeeded': {
    schemaVersion: 1,
    category: 'security',
    output: 'winston-console',
    persistToPostgres: false,
    outcome: 'SUCCESS',
    level: 'info',
    emitWhen: 'authentication-completed-and-session-committed',
    onLoggingFailure: 'preserve-authentication-result',
  },

  'auth.login.failed': {
    schemaVersion: 1,
    category: 'security',
    output: 'winston-console',
    persistToPostgres: false,
    outcome: 'FAILURE',
    level: 'warn',
    emitWhen: 'authentication-rejected',
    onLoggingFailure: 'preserve-authentication-result',
  },
} as const satisfies Record<AuthEventName, AuthEventPolicy>;
