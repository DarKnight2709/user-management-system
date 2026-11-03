import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { type Transporter } from 'nodemailer';

const SMTP_CONNECTION_TIMEOUT_MS = 20_000;
const SMTP_GREETING_TIMEOUT_MS = 5_000;
const SMTP_SOCKET_TIMEOUT_MS = 10_000;
const INVITATION_EMAIL_SUBJECT = 'Organization invitation';

export interface InvitationEmailMessage {
  to: string;
  organizationName: string;
  inviteLink: string;
  expiresAt: Date;
}

@Injectable()
export class EmailService implements OnApplicationShutdown {
  private readonly transport: Transporter;

  constructor(private readonly config: ConfigService) {
    this.transport = nodemailer.createTransport(this.getTransportOptions());
  }

  async sendInvitationEmail(message: InvitationEmailMessage): Promise<void> {
    const result = await this.transport.sendMail(
      this.createInvitationEmail(message),
    );
    this.assertRecipientAccepted(result.accepted);
  }

  onApplicationShutdown(): void {
    this.transport.close();
  }

  private getTransportOptions() {
    const user = this.config.get<string>('SMTP_USER');
    const secure = this.config.get<boolean>('SMTP_SECURE');

    return {
      host: this.config.getOrThrow<string>('SMTP_HOST'),
      port: this.config.getOrThrow<number>('SMTP_PORT'),
      secure,
      requireTLS: Boolean(user) && !secure,
      auth: user
        ? { user, pass: this.config.getOrThrow<string>('SMTP_PASSWORD') }
        : undefined,
      connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
      greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
      socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
    };
  }

  private createInvitationEmail({
    to,
    organizationName,
    inviteLink,
    expiresAt,
  }: InvitationEmailMessage) {
    return {
      from: this.config.getOrThrow<string>('SMTP_FROM'),
      to,
      subject: INVITATION_EMAIL_SUBJECT,
      text: [
        `You have been invited to join ${organizationName} as a member.`,
        '',
        inviteLink,
        '',
        `Expires: ${expiresAt.toISOString()}`,
        'Sign in with the invited email address to accept.',
      ].join('\n'),
      disableFileAccess: true,
      disableUrlAccess: true,
    };
  }

  private assertRecipientAccepted(accepted: string[] | undefined): void {
    if (!accepted?.length) {
      throw new Error('Recipient was not accepted by email provider');
    }
  }
}
