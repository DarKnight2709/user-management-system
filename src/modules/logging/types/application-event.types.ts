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
      event: 'http.payload_invalid';
      statusCode: 400;
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
      event: 'invitation.queue_unavailable';
      queue: 'invitation-email';
    }
  | {
      event: 'invitation.enqueue_unavailable';
      invitationId: string;
      version: number;
      stage: 'queue-acknowledgement' | 'database-mark-queued';
      queue: 'invitation-email';
    }
  | ({
      event: 'invitation.delivery_failed' | 'invitation.failure_record_failed';
      invitationId: string;
      version: number;
      stage: InvitationDeliveryStage;
    } & SafeEmailErrorFields)
  | ({
      event: 'email.worker_error';
      queue: 'invitation-email';
    } & SafeEmailErrorFields)
  | {
      event: 'email.job_failed';
      queue: 'invitation-email';
      invitationId?: string;
      version?: number;
      attempt?: number;
      maxAttempts?: number;
    }
  | {
      event: 'email.job_completed';
      queue: 'invitation-email';
      invitationId: string;
      version: number;
    }
  | {
      event: 'application.started';
      port: number;
    }
  | {
      event: 'application.shutdown_started' | 'application.shutdown_failed';
      signal: 'SIGINT' | 'SIGTERM';
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
    }
  | {
      event: 'auth.logout_session_failed';
      userId: string;
      scope: 'session_family';
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

export type SafeEmailErrorCode =
  | 'EDNS'
  | 'EAUTH'
  | 'ETIMEDOUT'
  | 'ESOCKET'
  | 'ECONNECTION'
  | 'ETLS'
  | 'ENOTFOUND'
  | 'EAI_AGAIN'
  | 'ENODATA'
  | 'ETIMEOUT'
  | 'ECONNREFUSED'
  | 'ECONNRESET'
  | 'EPIPE'
  | 'EENVELOPE'
  | 'EMESSAGE'
  | 'P1001'
  | 'P1002'
  | 'P1008'
  | 'P2024'
  | 'P2025'
  | 'P2034'
  | 'UNKNOWN';

type SafeEmailErrorFields = {
  code: SafeEmailErrorCode;
  responseCode?: number;
};

export type InvitationDeliveryStage =
  | 'database-read'
  | 'link-configuration'
  | 'smtp-send'
  | 'database-record-sent'
  | 'database-record-failed';
