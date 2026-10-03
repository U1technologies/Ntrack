import type { EmailJob } from '@ntrack/shared';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
}

/** Reads SMTP_* variables. Returns null when email is not configured, which disables sending. */
export const smtpConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): SmtpConfig | null => {
  if (!env.SMTP_HOST || !env.SMTP_FROM) return null;
  return {
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT ?? 587),
    secure: env.SMTP_SECURE === 'true',
    user: env.SMTP_USER ?? '',
    password: env.SMTP_PASSWORD ?? '',
    from: env.SMTP_FROM,
  };
};

export interface EmailSender {
  readonly enabled: boolean;
  send(job: EmailJob): Promise<void>;
}

export class DisabledEmailSender implements EmailSender {
  readonly enabled = false;
  async send(): Promise<void> {
    // Intentionally a no-op: email is off until SMTP_* is configured. In-app notifications still work.
  }
}

export class SmtpEmailSender implements EmailSender {
  readonly enabled = true;
  private transport: import('nodemailer').Transporter | null = null;

  constructor(private readonly config: SmtpConfig) {}

  async send(job: EmailJob): Promise<void> {
    if (!this.transport) {
      const nodemailer = await import('nodemailer');
      this.transport = nodemailer.createTransport({
        host: this.config.host,
        port: this.config.port,
        secure: this.config.secure,
        requireTLS: !this.config.secure,
        auth: this.config.user ? { user: this.config.user, pass: this.config.password } : undefined,
      });
    }
    await this.transport.sendMail({
      from: this.config.from,
      to: job.to,
      subject: job.subject,
      text: job.text,
      html: job.html,
      attachments: job.attachments?.map((a) => ({ filename: a.filename, contentType: a.contentType, content: Buffer.from(a.contentBase64, 'base64') })),
    });
  }
}

export const createEmailSender = (config: SmtpConfig | null): EmailSender => (config ? new SmtpEmailSender(config) : new DisabledEmailSender());
