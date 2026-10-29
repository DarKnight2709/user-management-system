type ApplicationRequestContext = {
  requestId: string;
};

export type ApplicationEventInput =
  | (HttpRequestFields & {
      event: 'http.request.completed';
      statusCode: number;
      outcome: 'completed';
    })
  | (HttpRequestFields & {
      event: 'http.request.aborted';
      statusCode: null;
      outcome: 'aborted';
    })
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

type HttpRequestFields = {
  method: string;
  route: string;
  durationMs: number;
  requestContext: ApplicationRequestContext;
};
