import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { InputValidationPipe } from '@/common/pipes/validation.pipe.js';
import { LoginDto } from '../dto/auth.dto.js';

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The shared pipe coerces types; credentials must be strings exactly as sent. */
function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Validates the login body before the local strategy reads it. Guards run
 * before pipes, so without this LoginDto never applied and a non-string email
 * reached the database lookup (500). It runs after the global throttling
 * guards, so invalid attempts are still counted and never reach bcrypt.
 */
@Injectable()
export class LoginValidationGuard implements CanActivate {
  private readonly pipe = new InputValidationPipe();

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const body: unknown = request.body;
    const source = isJsonObject(body) ? body : {};

    const dto = await this.pipe.transform(
      {
        ...source,
        email: stringOrUndefined(source.email),
        password: stringOrUndefined(source.password),
      },
      { type: 'body', metatype: LoginDto },
    );

    request.body = { email: dto.email, password: dto.password };
    return true;
  }
}
