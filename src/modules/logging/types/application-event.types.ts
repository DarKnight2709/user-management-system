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
      event: 'http.operational_error';
      statusCode: number;
      requestContext: ApplicationRequestContext;
    }
  | {
      event: 'http.payload_too_large';
      statusCode: 413;
      requestContext: ApplicationRequestContext;
    }
  | {
      event: 'http.unhandled_error';
      statusCode: 500;
      errorType: StandardErrorType | 'NonError';
      stackFrames?: string[];
      requestContext: ApplicationRequestContext;
    }
  | {
      event: 'database.unhandled_error';
      code: string;
      requestContext: ApplicationRequestContext;
    }
  | (DatabaseDriverEvent & {
      event: 'database.info' | 'database.warning' | 'database.error';
    })
  | (DatabaseQueryEvent & {
      event: 'database.query_completed';
    })
  | (DatabaseQueryEvent & {
      event: 'database.slow_query';
      thresholdMs: number;
    })
  | {
      event: 'avatar.cleanup_worker_failed';
      errorCategory: BackgroundErrorCategory;
    }
  | {
      event: 'avatar.cleanup_retry_scheduling_failed';
      taskId: string;
      attempt: number;
      errorCategory: BackgroundErrorCategory;
      schedulingErrorCategory: BackgroundErrorCategory;
    }
  | {
      event: 'avatar.cleanup_retry_scheduled';
      taskId: string;
      attempt: number;
      errorCategory: BackgroundErrorCategory;
      retryDelayMs: number;
    }
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

type StandardErrorType =
  | 'Error'
  | 'TypeError'
  | 'RangeError'
  | 'ReferenceError'
  | 'SyntaxError'
  | 'URIError'
  | 'EvalError'
  | 'AggregateError';

type DatabaseDriverEvent = {
  requestContext?: ApplicationRequestContext;
};

type DatabaseQueryEvent = DatabaseDriverEvent & {
  queryFingerprint: string;
  durationMs: number;
};

export type BackgroundErrorCategory =
  | 'database'
  | 'timeout'
  | 'storage_authorization'
  | 'storage_bucket_missing'
  | 'storage_unavailable'
  | 'unknown';
