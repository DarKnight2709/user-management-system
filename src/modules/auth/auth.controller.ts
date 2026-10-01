import { Controller, Post, Req, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import type { Request } from 'express';
import { AuthGuard } from '@nestjs/passport';
import { ValidCredential } from '../users/interfaces/user.interface.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @UseGuards(AuthGuard('local'))
  @Post('login')
  async login(@Req() req: Request) {
    return this.authService.login(req.user as ValidCredential);
  }
}
