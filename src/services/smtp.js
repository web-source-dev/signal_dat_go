import nodemailer from "nodemailer";

export const SMTP_PRESETS = {
  gmail: { host: "smtp.gmail.com", port: 587, secure: false },
  outlook: { host: "smtp.office365.com", port: 587, secure: false },
  yahoo: { host: "smtp.mail.yahoo.com", port: 587, secure: false },
  icloud: { host: "smtp.mail.me.com", port: 587, secure: false },
};

export function createSmtpTransport(config) {
  const { email, password, smtpHost, smtpPort, smtpSecure } = config;
  if (!email || !password || !smtpHost || !smtpPort) {
    throw new Error("Email, password, SMTP host, and port are required");
  }

  return nodemailer.createTransport({
    host: smtpHost,
    port: Number(smtpPort),
    secure: Boolean(smtpSecure),
    auth: { user: email, pass: password },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
}

export async function verifySmtpConnection(config) {
  const transport = createSmtpTransport(config);
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
}

export async function sendSmtpEmail(config, { to, subject, bodyHtml, inReplyToMessageId }) {
  const transport = createSmtpTransport(config);
  try {
    const headers = {};
    if (inReplyToMessageId) {
      headers.inReplyTo = inReplyToMessageId;
      headers.references = inReplyToMessageId;
    }
    const info = await transport.sendMail({
      from: config.email,
      to,
      subject,
      html: bodyHtml,
      text: bodyHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      headers,
    });
    return {
      providerMessageId: info.messageId ?? null,
      providerThreadId: info.messageId ?? null,
    };
  } finally {
    transport.close();
  }
}
