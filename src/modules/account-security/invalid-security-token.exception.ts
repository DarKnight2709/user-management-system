import { BadRequestException } from '@nestjs/common';
import { INVALID_SECURITY_TOKEN_MESSAGE } from './constants/account-security.constant.js';

/** One message for unknown, used, expired and replaced tokens, so none can be told apart. */
export class InvalidSecurityTokenException extends BadRequestException {
  constructor() {
    super(INVALID_SECURITY_TOKEN_MESSAGE);
  }
}
