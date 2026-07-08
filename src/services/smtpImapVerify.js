import { ImapFlow } from "imapflow";
import { inferImapFromSmtp } from "./smtpImap.js";

export function resolveImapSettings(config) {
  const meta = config.providerMetadata ?? {};
  if (meta.imapHost) {
    return {
      imapHost: meta.imapHost,
      imapPort: Number(meta.imapPort ?? 993),
      imapSecure: meta.imapSecure !== false,
    };
  }
  return inferImapFromSmtp(config.smtpHost, config.email);
}

export async function verifyImapConnection({ email, password, imapHost, imapPort, imapSecure }) {
  const client = new ImapFlow({
    host: imapHost,
    port: Number(imapPort),
    secure: Boolean(imapSecure),
    auth: { user: email, pass: password },
    logger: false,
  });
  await client.connect();
  try {
    await client.mailboxOpen("INBOX");
  } finally {
    await client.logout();
  }
}
