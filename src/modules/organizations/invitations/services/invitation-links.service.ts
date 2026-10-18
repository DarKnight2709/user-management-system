import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac } from 'node:crypto';

@Injectable()
export class InvitationLinksService {
  constructor(private readonly config: ConfigService) {}

  token(id: string): string {
    const secret = this.config.get<string>('INVITATION_TOKEN_SECRET');
    if (!secret || secret.length < 64) {
      throw new ServiceUnavailableException(
        'Invitation token configuration is unavailable',
      );
    }
    return createHmac('sha256', secret)
      .update(`organization-invitation:${id}`)
      .digest('hex');
  }

  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  link(id: string): string {
    const origin = this.config.get<string>('FRONTEND_URL');
    if (!origin)
      throw new ServiceUnavailableException(
        'Invitation frontend configuration is unavailable',
      );
    const url = new URL('invitations/accept', `${origin.replace(/\/+$/, '')}/`);
    // A fragment stays out of HTTP access logs and Referer headers.
    url.hash = `token=${this.token(id)}`;
    return url.toString();
  }
}
