import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-local';
import { AuthService } from '../auth.service.js';
import { Injectable } from '@nestjs/common';
import type { Request } from 'express';

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly authService: AuthService) {
    super({
      usernameField: 'email',
      passReqToCallback: true,
    });
  }

  async validate(request: Request, email: string, password: string) {
    const user = await this.authService.validateUser(
      email,
      password,
      request.ip,
      request.get('user-agent'),
    );
    return user;
  }
}
