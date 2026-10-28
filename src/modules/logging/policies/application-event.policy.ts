import type { ApplicationEventInput } from '../types/application-event.types.js';

type ApplicationEventPolicy = {
  schemaVersion: 1;
  category: 'application';
  level: 'error';
  message: string;
  output: 'winston-console';
  persistToPostgres: false;
  onLoggingFailure: 'preserve-operation-result';
};

export const APPLICATION_EVENT_POLICIES = {
  'auth.refresh_failed': {
    schemaVersion: 1,
    category: 'application',
    level: 'error',
    message: 'Refresh token processing failed',
    output: 'winston-console',
    persistToPostgres: false,
    onLoggingFailure: 'preserve-operation-result',
  },
  'auth.logout_failed': {
    schemaVersion: 1,
    category: 'application',
    level: 'error',
    message: 'Logout failed',
    output: 'winston-console',
    persistToPostgres: false,
    onLoggingFailure: 'preserve-operation-result',
  },
} as const satisfies Record<ApplicationEventInput['event'], ApplicationEventPolicy>;
