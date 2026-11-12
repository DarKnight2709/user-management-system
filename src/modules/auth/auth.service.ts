import { Injectable, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { compare, hash } from '@/common/utils/hash.util.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { UsersService } from '@/modules/users/users.service.js';
import { EmailVerificationService } from '@/modules/account-security/services/email-verification.service.js';
import { RegisterDto } from './dto/auth.dto.js';
import type { AuthenticatedUser } from './interfaces/auth.interface.js';
import { authRequestContext } from './utils/auth-request-context.util.js';
import { toCredentialRef } from './utils/credential-ref.util.js';
import { DUMMY_PASSWORD_BYTES } from './constants/auth.constant.js';

@Injectable()
export class AuthService {
  private readonly dummyPasswordHash: Promise<string> = hash(
    randomBytes(DUMMY_PASSWORD_BYTES).toString('hex'),
  );

  constructor(
    private readonly userService: UsersService,
    private readonly loggingService: LoggingService,
    private readonly emailVerification: EmailVerificationService,
  ) {
    // A failure surfaces when a login awaits it; do not crash on an unhandled rejection.
    this.dummyPasswordHash.catch(() => undefined);
  }

  async validateUser(
    email: string,
    password: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthenticatedUser> {
    const user = await this.userService.findOneByEmail(email);

    // Always run one bcrypt comparison: response time must not reveal whether
    // the email belongs to an account.
    const storedHash = user?.hashedPassword ?? (await this.dummyPasswordHash);
    const passwordMatches = await compare(password, storedHash);

    if (!user?.hashedPassword || !passwordMatches) {
      this.logLoginFailure(ipAddress, userAgent);
      throw new UnauthorizedException('Invalid credentials');
    }

    return {
      id: user.id,
      username: user.username,
      email: user.email,
      credentialRef: toCredentialRef(user.hashedPassword),
    };
  }

  async register(dto: RegisterDto, ipAddress?: string, userAgent?: string) {
    const hashedPassword = await hash(dto.password);

    const user = await this.userService.create({
      username: dto.username.trim().toLowerCase(),
      hashedPassword,
      firstName: dto.firstName,
      lastName: dto.lastName,
      birthDate: dto.birthDate,
      email: dto.email.trim().toLowerCase(),
    });

    this.loggingService.security({
      action: 'auth.registration.succeeded',
      actor: { type: 'ANONYMOUS' },
      target: { type: 'USER', id: user.id },
      requestContext: authRequestContext(ipAddress, userAgent),
    });

    await this.emailVerification.sendTo(user.id);
  }

  private logLoginFailure(ipAddress?: string, userAgent?: string): void {
    this.loggingService.security({
      action: 'auth.login.failed',
      actor: { type: 'ANONYMOUS' },
      authMethod: 'PASSWORD',
      reasonCode: 'INVALID_CREDENTIALS',
      requestContext: authRequestContext(ipAddress, userAgent),
    });
  }
}
