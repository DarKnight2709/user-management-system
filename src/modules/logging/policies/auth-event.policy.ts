export type AuthEventName =
  | 'auth.login.succeeded'
  | 'auth.login.failed'
  | 'auth.password.changed'
  | 'auth.refresh_token.reuse_detected'
  | 'auth.logout.completed';

type AuthEventPolicy = {
  schemaVersion: 1;
  category: 'security';
  output: 'winston-console';
  persistToPostgres: false;

  outcome: 'SUCCESS' | 'FAILURE';
  level: 'info' | 'warn';

  emitWhen:
    | 'authentication-completed-and-session-committed'
    | 'authentication-rejected'
    | 'password-change-committed'
    | 'revoked-refresh-token-reused'
    | 'logout-revocation-committed';

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

  'auth.password.changed': {
    schemaVersion: 1,
    category: 'security',
    output: 'winston-console',
    persistToPostgres: false,
    outcome: 'SUCCESS',
    level: 'info',
    emitWhen: 'password-change-committed',
    onLoggingFailure: 'preserve-authentication-result',
  },

  'auth.refresh_token.reuse_detected': {
    schemaVersion: 1,
    category: 'security',
    output: 'winston-console',
    persistToPostgres: false,
    outcome: 'FAILURE',
    level: 'warn',
    emitWhen: 'revoked-refresh-token-reused',
    onLoggingFailure: 'preserve-authentication-result',
  },

  'auth.logout.completed': {
    schemaVersion: 1,
    category: 'security',
    output: 'winston-console',
    persistToPostgres: false,
    outcome: 'SUCCESS',
    level: 'info',
    emitWhen: 'logout-revocation-committed',
    onLoggingFailure: 'preserve-authentication-result',
  },
} as const satisfies Record<AuthEventName, AuthEventPolicy>;
