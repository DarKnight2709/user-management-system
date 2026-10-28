type ApplicationRequestContext = {
  requestId: string;
};

export type ApplicationEventInput =
  | {
      event: 'auth.refresh_failed';
      requestContext: ApplicationRequestContext;
    }
  | {
      event: 'auth.logout_failed';
      userId: string;
      scope: 'all_sessions';
      requestContext: ApplicationRequestContext;
    };
