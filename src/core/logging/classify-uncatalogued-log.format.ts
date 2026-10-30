import { format } from 'winston';

/** Add stable fields to framework and other Winston records outside the catalog. */
export const classifyUncataloguedLogs = format((info) => {
  if (typeof info.category !== 'string') {
    info.category = 'application';
  }

  if (typeof info.event !== 'string') {
    info.event = 'framework.log';
  }

  return info;
});
