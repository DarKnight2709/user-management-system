import type { ApplicationEventInput } from '../types/application-event.types.js';

type ApplicationEventPolicy = {
  schemaVersion: 1;
  category: 'application';
  level: 'info' | 'warn' | 'error';
  message: string;
  output: 'winston-console';
  persistToPostgres: false;
  onLoggingFailure: 'preserve-operation-result';
};

export const APPLICATION_EVENT_POLICIES = {
  'http.request.completed': {
    schemaVersion: 1,
    category: 'application',
    level: 'info',
    message: 'HTTP request completed',
    output: 'winston-console',
    persistToPostgres: false,
    onLoggingFailure: 'preserve-operation-result',
  },
  'http.request.aborted': {
    schemaVersion: 1,
    category: 'application',
    level: 'warn',
    message: 'HTTP request aborted',
    output: 'winston-console',
    persistToPostgres: false,
    onLoggingFailure: 'preserve-operation-result',
  },
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
} as const satisfies Record<
  ApplicationEventInput['event'],
  ApplicationEventPolicy
>;

export function applicationEventLevel(
  event: ApplicationEventInput,
): ApplicationEventPolicy['level'] {
  if (event.event === 'http.request.completed') {
    if (event.statusCode >= 500) return 'error';
    if (event.statusCode >= 400) return 'warn';
  }
  return APPLICATION_EVENT_POLICIES[event.event].level;
}
