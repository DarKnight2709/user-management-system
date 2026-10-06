import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '@/modules/users/users.service.js';
import { User } from '@/modules/users/interfaces/user.interface.js';
export interface JwtPayload {
  sub: string;
  username: string;
  email: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      algorithms: ['HS256'],
      secretOrKey: configService.get<string>(
        'JWT_ACCESS_TOKEN_SECRET',
      ) as string,
    });
  }

  // password passes the decoded payload when completing verifying
  async validate(payload: unknown) {
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('sub' in payload) ||
      typeof payload.sub !== 'string' ||
      payload.sub.trim().length === 0
    ) {
      throw new UnauthorizedException('Invalid credentials');
    }
    let user: User;
    try {
      user = await this.usersService.findOne(payload.sub);
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new UnauthorizedException('Invalid credentials');
      }
      throw error;
    }
    // attached to req.user
    return {
      id: user.id,
      email: user.email,
      username: user.username,
    };
  }
}
