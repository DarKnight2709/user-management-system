import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { type SendMailOptions, type Transporter } from 'nodemailer';

const SMTP_CONNECTION_TIMEOUT_MS = 20_000;
const SMTP_GREETING_TIMEOUT_MS = 5_000;
const SMTP_SOCKET_TIMEOUT_MS = 10_000;
const INVITATION_EMAIL_SUBJECT = 'Organization invitation';
const PASSWORD_RESET_EMAIL_SUBJECT = 'Reset your password';

export interface InvitationEmailMessage {
  to: string;
  organizationName: string;
  inviteLink: string;
  expiresAt: Date;
}

export interface PasswordResetEmailMessage {
  to: string;
  resetLink: string;
  expiresAt: Date;
}

@Injectable()
export class EmailService implements OnApplicationShutdown {
  private readonly transport: Transporter;

  constructor(private readonly config: ConfigService) {
    this.transport = nodemailer.createTransport(this.getTransportOptions());
  }

  async sendInvitationEmail(message: InvitationEmailMessage): Promise<void> {
    await this.send(this.createInvitationEmail(message));
  }

  async sendPasswordResetEmail(
    message: PasswordResetEmailMessage,
  ): Promise<void> {
    await this.send(this.createPasswordResetEmail(message));
  }

  onApplicationShutdown(): void {
    this.transport.close();
  }

  private async send(mail: SendMailOptions): Promise<void> {
    const result = await this.transport.sendMail(mail);
    this.assertRecipientAccepted(result.accepted);
  }

  private createMail(to: string, subject: string, lines: string[]) {
    return {
      from: this.config.getOrThrow<string>('SMTP_FROM'),
      to,
      subject,
      text: lines.join('\n'),
      disableFileAccess: true,
      disableUrlAccess: true,
    };
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
    return this.createMail(to, INVITATION_EMAIL_SUBJECT, [
      `You have been invited to join ${organizationName} as a member.`,
      '',
      inviteLink,
      '',
      `Expires: ${expiresAt.toISOString()}`,
      'Sign in with the invited email address to accept.',
    ]);
  }

  private createPasswordResetEmail({
    to,
    resetLink,
    expiresAt,
  }: PasswordResetEmailMessage) {
    return this.createMail(to, PASSWORD_RESET_EMAIL_SUBJECT, [
      'We received a request to reset the password of your account.',
      '',
      resetLink,
      '',
      `The link expires: ${expiresAt.toISOString()}`,
      'If you did not ask for this, ignore this email. Your password stays the same.',
    ]);
  }

  private assertRecipientAccepted(accepted: string[] | undefined): void {
    if (!accepted?.length) {
      throw new Error('Recipient was not accepted by email provider');
    }
  }
}
