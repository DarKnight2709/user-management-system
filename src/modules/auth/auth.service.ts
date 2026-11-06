import { Injectable, UnauthorizedException } from '@nestjs/common';
import { compare, hash } from '@/common/utils/hash.util.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { UsersService } from '@/modules/users/users.service.js';
import { RegisterDto } from './dto/auth.dto.js';
import { authRequestContext } from './utils/auth-request-context.util.js';

/** Credential validation and account registration. */
@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UsersService,
    private readonly loggingService: LoggingService,
  ) {}

  async validateUser(
    email: string,
    password: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    const user = await this.userService.findOneByEmail(email);
    if (!user) {
      this.logLoginFailure(ipAddress, userAgent);
      throw new UnauthorizedException('Invalid credentials');
    }

    const isValidPassword = await compare(
      password,
      user.hashedPassword as string,
    );

    if (!isValidPassword) {
      this.logLoginFailure(ipAddress, userAgent);
      throw new UnauthorizedException('Invalid credentials');
    }

    return {
      id: user.id,
      username: user.username,
      email: user.email,
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
