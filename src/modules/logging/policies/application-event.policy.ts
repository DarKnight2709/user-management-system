import type { ApplicationEventInput } from '../types/application-event.types.js';

type ApplicationEventPolicy = {
  schemaVersion: 1;
  category: 'application';
  level: 'debug' | 'info' | 'warn' | 'error';
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
  'http.operational_error': {
    schemaVersion: 1,
    category: 'application',
    level: 'warn',
    message: 'HTTP request failed',
    output: 'winston-console',
    persistToPostgres: false,
    onLoggingFailure: 'preserve-operation-result',
  },
  'http.payload_too_large': {
    schemaVersion: 1,
    category: 'application',
    level: 'warn',
    message: 'Request body exceeds the allowed size',
    output: 'winston-console',
    persistToPostgres: false,
    onLoggingFailure: 'preserve-operation-result',
  },
  'http.unhandled_error': {
    schemaVersion: 1,
    category: 'application',
    level: 'error',
    message: 'Unhandled request error',
    output: 'winston-console',
    persistToPostgres: false,
    onLoggingFailure: 'preserve-operation-result',
  },
  'database.unhandled_error': {
    schemaVersion: 1,
    category: 'application',
    level: 'error',
    message: 'Unhandled database error',
    output: 'winston-console',
    persistToPostgres: false,
    onLoggingFailure: 'preserve-operation-result',
  },
  'database.info': {
    schemaVersion: 1,
    category: 'application',
    level: 'info',
    message: 'Database information event',
    output: 'winston-console',
    persistToPostgres: false,
    onLoggingFailure: 'preserve-operation-result',
  },
  'database.warning': {
    schemaVersion: 1,
    category: 'application',
    level: 'warn',
    message: 'Database warning',
    output: 'winston-console',
    persistToPostgres: false,
    onLoggingFailure: 'preserve-operation-result',
  },
  'database.error': {
    schemaVersion: 1,
    category: 'application',
    level: 'error',
    message: 'Database error event',
    output: 'winston-console',
    persistToPostgres: false,
    onLoggingFailure: 'preserve-operation-result',
  },
  'database.query_completed': {
    schemaVersion: 1,
    category: 'application',
    level: 'debug',
    message: 'Database query completed',
    output: 'winston-console',
    persistToPostgres: false,
    onLoggingFailure: 'preserve-operation-result',
  },
  'database.slow_query': {
    schemaVersion: 1,
    category: 'application',
    level: 'warn',
    message: 'Slow database query',
    output: 'winston-console',
    persistToPostgres: false,
    onLoggingFailure: 'preserve-operation-result',
  },
  'avatar.cleanup_worker_failed': {
    schemaVersion: 1,
    category: 'application',
    level: 'error',
    message: 'Avatar cleanup worker failed',
    output: 'winston-console',
    persistToPostgres: false,
    onLoggingFailure: 'preserve-operation-result',
  },
  'avatar.cleanup_retry_scheduling_failed': {
    schemaVersion: 1,
    category: 'application',
    level: 'error',
    message: 'Avatar cleanup retry scheduling failed',
    output: 'winston-console',
    persistToPostgres: false,
    onLoggingFailure: 'preserve-operation-result',
  },
  'avatar.cleanup_retry_scheduled': {
    schemaVersion: 1,
    category: 'application',
    level: 'warn',
    message: 'Avatar cleanup retry scheduled',
    output: 'winston-console',
    persistToPostgres: false,
    onLoggingFailure: 'preserve-operation-result',
  },
  'invitation.queue_unavailable': {
    schemaVersion: 1,
    category: 'application',
    level: 'warn',
    message: 'Invitation queue connection unavailable',
    output: 'winston-console',
    persistToPostgres: false,
    onLoggingFailure: 'preserve-operation-result',
  },
  'invitation.enqueue_unavailable': {
    schemaVersion: 1,
    category: 'application',
    level: 'warn',
    message: 'Invitation email enqueue unavailable',
    output: 'winston-console',
    persistToPostgres: false,
    onLoggingFailure: 'preserve-operation-result',
  },
  'invitation.delivery_failed': {
    schemaVersion: 1,
    category: 'application',
    level: 'warn',
    message: 'Invitation email delivery failed',
    output: 'winston-console',
    persistToPostgres: false,
    onLoggingFailure: 'preserve-operation-result',
  },
  'invitation.failure_record_failed': {
    schemaVersion: 1,
    category: 'application',
    level: 'warn',
    message: 'Invitation delivery failure could not be recorded',
    output: 'winston-console',
    persistToPostgres: false,
    onLoggingFailure: 'preserve-operation-result',
  },
  'email.worker_error': {
    schemaVersion: 1,
    category: 'application',
    level: 'warn',
    message: 'Email worker encountered an error',
    output: 'winston-console',
    persistToPostgres: false,
    onLoggingFailure: 'preserve-operation-result',
  },
  'email.job_failed': {
    schemaVersion: 1,
    category: 'application',
    level: 'warn',
    message: 'Email job attempt failed',
    output: 'winston-console',
    persistToPostgres: false,
    onLoggingFailure: 'preserve-operation-result',
  },
  'email.job_completed': {
    schemaVersion: 1,
    category: 'application',
    level: 'info',
    message: 'Email job completed',
    output: 'winston-console',
    persistToPostgres: false,
    onLoggingFailure: 'preserve-operation-result',
  },
  'application.started': {
    schemaVersion: 1,
    category: 'application',
    level: 'info',
    message: 'Application started',
    output: 'winston-console',
    persistToPostgres: false,
    onLoggingFailure: 'preserve-operation-result',
  },
  'application.shutdown_started': {
    schemaVersion: 1,
    category: 'application',
    level: 'info',
    message: 'Application shutdown started',
    output: 'winston-console',
    persistToPostgres: false,
    onLoggingFailure: 'preserve-operation-result',
  },
  'application.shutdown_failed': {
    schemaVersion: 1,
    category: 'application',
    level: 'error',
    message: 'Application shutdown failed',
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
  'auth.logout_session_failed': {
    schemaVersion: 1,
    category: 'application',
    level: 'error',
    message: 'Session logout failed',
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
  if (event.event === 'http.operational_error' && event.statusCode >= 500) {
    return 'error';
  }
  return APPLICATION_EVENT_POLICIES[event.event].level;
}
