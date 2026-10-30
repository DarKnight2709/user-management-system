import type { SecurityRequestContext } from './security-request-context.types.js';

export type AuthSecurityEventInput =
  | {
      action: 'auth.registration.succeeded';
      actor: { type: 'ANONYMOUS' };
      target: { type: 'USER'; id: string };
      requestContext: SecurityRequestContext;
    }
  | {
      action: 'auth.password.change_failed';
      actor: { type: 'USER'; id: string };
      reasonCode: 'INVALID_CURRENT_PASSWORD';
      requestContext: SecurityRequestContext;
    }
  | {
      action: 'auth.login.succeeded';
      actor: {
        type: 'USER';
        id: string;
      };
      authMethod: 'PASSWORD';
      sessionRef: string;
      requestContext: SecurityRequestContext;
    }
  | {
      action: 'auth.login.failed';
      actor: {
        type: 'ANONYMOUS';
      };
      authMethod: 'PASSWORD';
      reasonCode: 'INVALID_CREDENTIALS' | 'ACCOUNT_UNAVAILABLE';
      loginIdentifierRef?: string;
      requestContext: SecurityRequestContext;
    }
  | {
      action: 'auth.password.changed';
      actor: {
        type: 'USER';
        id: string;
      };
      requestContext: SecurityRequestContext;
    }
  | {
      action: 'auth.refresh_token.reuse_detected';
      actor: {
        type: 'ANONYMOUS';
      };
      target: {
        type: 'USER';
        id: string;
      };
      sessionRef: string;
      requestContext: SecurityRequestContext;
    }
  | {
      action: 'auth.logout.completed';
      actor: {
        type: 'USER';
        id: string;
      };
      scope: 'SESSION_FAMILY';
      sessionRef?: string;
      requestContext: SecurityRequestContext;
    }
  | {
      action: 'auth.logout.completed';
      actor: {
        type: 'USER';
        id: string;
      };
      scope: 'ALL_SESSIONS';
      requestContext: SecurityRequestContext;
    }
  | {
      action: 'auth.login.throttled';
      actor: {
        type: 'ANONYMOUS';
      };
      limitPolicy: 'IP' | 'ACCOUNT';
      requestContext: SecurityRequestContext;
    };
