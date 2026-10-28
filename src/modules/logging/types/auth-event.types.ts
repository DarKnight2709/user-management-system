type AuthRequestContext = {
  requestId: string;
  sourceIp?: string;
  userAgent?: string;
};

export type AuthSecurityEventInput =
  | {
      action: 'auth.login.succeeded';
      actor: {
        type: 'USER';
        id: string;
      };
      authMethod: 'PASSWORD';
      sessionRef: string;
      requestContext: AuthRequestContext;
    }
  | {
      action: 'auth.login.failed';
      actor: {
        type: 'ANONYMOUS';
      };
      authMethod: 'PASSWORD';
      reasonCode: 'INVALID_CREDENTIALS' | 'ACCOUNT_UNAVAILABLE';
      loginIdentifierRef?: string;
      requestContext: AuthRequestContext;
    }
  | {
      action: 'auth.password.changed';
      actor: {
        type: 'USER';
        id: string;
      };
      requestContext: AuthRequestContext;
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
      requestContext: AuthRequestContext;
    };
