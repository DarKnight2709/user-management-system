import { format } from 'winston';
import { redactLog } from '@/common/utils/redact-log.util.js';

export const redactSensitiveData = format((info) => {
  const redacted = redactLog(info);

  if (
    redacted === null ||
    typeof redacted !== 'object' ||
    Array.isArray(redacted)
  ) {
    return false;
  }

  // Keep Winston's internal Symbol properties on the original record.
  for (const [key, value] of Object.entries(redacted)) {
    info[key] = value;
  }

  return info;
});
