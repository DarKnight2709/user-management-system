import type { AuthorizationDeniedEventInput } from '../types/security-event.types.js';

type AuthorizationEventPolicy = {
  schemaVersion: 1;
  category: 'security';
  output: 'winston-console';
  persistToPostgres: false;
  outcome: 'FAILURE';
  level: 'warn';
  emitWhen: 'authorization-rejected';
  onLoggingFailure: 'preserve-authorization-result';
};

export const AUTHORIZATION_EVENT_POLICIES = {
  'authorization.denied': {
    schemaVersion: 1,
    category: 'security',
    output: 'winston-console',
    persistToPostgres: false,
    outcome: 'FAILURE',
    level: 'warn',
    emitWhen: 'authorization-rejected',
    onLoggingFailure: 'preserve-authorization-result',
  },
} as const satisfies Record<
  AuthorizationDeniedEventInput['action'],
  AuthorizationEventPolicy
>;
