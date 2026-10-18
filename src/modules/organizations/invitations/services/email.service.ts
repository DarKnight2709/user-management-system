import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { type Transporter } from 'nodemailer';

@Injectable()
export class EmailService implements OnApplicationShutdown {
  private readonly transport: Transporter;

  constructor(private readonly config: ConfigService) {
    const user = this.config.get<string>('SMTP_USER');
    const secure = this.config.get<boolean>('SMTP_SECURE');
    this.transport = nodemailer.createTransport({
      host: this.config.getOrThrow<string>('SMTP_HOST'),
      port: this.config.getOrThrow<number>('SMTP_PORT'),
      secure,
      requireTLS: Boolean(user) && !secure,
      auth: user
        ? { user, pass: this.config.getOrThrow<string>('SMTP_PASSWORD') }
        : undefined,
      // Nodemailer includes DNS resolution in this deadline.
      connectionTimeout: 20_000,
      greetingTimeout: 5_000,
      socketTimeout: 10_000,
    });
  }

  async sendInvitationEmail(
    to: string,
    organizationName: string,
    inviteLink: string,
    expiresAt: Date,
  ): Promise<void> {
    const result = await this.transport.sendMail({
      from: this.config.getOrThrow<string>('SMTP_FROM'),
      to,
      subject: 'Organization invitation',
      text: `You have been invited to join ${organizationName} as a member.\n\n${inviteLink}\n\nExpires: ${expiresAt.toISOString()}\nSign in with the invited email address to accept.`,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    if (!result.accepted?.length)
      throw new Error('Recipient was not accepted by email provider');
  }

  onApplicationShutdown(): void {
    this.transport.close();
  }
}
