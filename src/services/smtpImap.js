import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

export function inferImapFromSmtp(smtpHost, email) {
  if (!smtpHost) return null;
  const host = smtpHost.toLowerCase();
  const domain = (email?.split("@")[1] ?? "").toLowerCase();

  if (host.includes("gmail") || host.includes("google")) {
    return { imapHost: "imap.gmail.com", imapPort: 993, imapSecure: true };
  }
  if (host.includes("office365") || host.includes("outlook") || host.includes("microsoft")) {
    return { imapHost: "outlook.office365.com", imapPort: 993, imapSecure: true };
  }
  if (host.includes("yahoo")) {
    return { imapHost: "imap.mail.yahoo.com", imapPort: 993, imapSecure: true };
  }
  if (host.includes("mail.me.com") || host.includes("icloud")) {
    return { imapHost: "imap.mail.me.com", imapPort: 993, imapSecure: true };
  }
  if (host.startsWith("smtp.")) {
    return { imapHost: host.replace(/^smtp\./, "imap."), imapPort: 993, imapSecure: true };
  }
  if (domain) {
    return { imapHost: `imap.${domain}`, imapPort: 993, imapSecure: true };
  }
  return { imapHost: host, imapPort: 993, imapSecure: true };
}

function normalizeEmail(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  const match = raw.match(/<([^>]+)>/);
  return (match?.[1] ?? raw).trim();
}

function normalizeSubject(subject) {
  return (subject ?? "")
    .replace(/^(re|fwd):\s*/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function subjectsRelated(threadSubject, messageSubject) {
  const a = normalizeSubject(threadSubject);
  const b = normalizeSubject(messageSubject);
  if (!a || !b) return true;
  if (a.includes(b) || b.includes(a)) return true;

  const tokens = (text) =>
    text
      .split(/[^a-z0-9]+/i)
      .map((token) => token.trim())
      .filter((token) => token.length > 3);

  const overlap = tokens(a).filter((token) => tokens(b).some((other) => other.includes(token) || token.includes(other)));
  return overlap.length >= 2;
}

function messageSourceText(source) {
  if (!source) return "";
  return Buffer.isBuffer(source) ? source.toString("utf8") : String(source);
}

function referencesOurMessage(source, sentMessageIds) {
  if (!source || !sentMessageIds?.length) return false;
  const raw = messageSourceText(source);
  return sentMessageIds.some((id) => {
    if (!id) return false;
    const bare = id.replace(/^<|>$/g, "");
    return raw.includes(id) || raw.includes(bare);
  });
}

function isDirectBrokerReply(fromAddresses, brokerEmail, mailboxEmail) {
  if (!isFromBroker(fromAddresses, brokerEmail)) return false;
  const broker = normalizeEmail(brokerEmail);
  const mailbox = normalizeEmail(mailboxEmail);
  if (!broker || !mailbox) return true;
  return broker !== mailbox;
}

function stripQuotedHistory(text) {
  const lines = String(text ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n");

  const kept = [];
  for (const line of lines) {
    const trimmed = line.trim();
    // Stop at quoted-reply markers and forwarded headers
    if (/^>/.test(trimmed)) break;
    if (/^On .{4,120} wrote:\s*$/i.test(trimmed)) break;
    if (/^-{2,}\s*Original Message\s*-{0,}/i.test(trimmed)) break;
    if (/^_{5,}\s*$/.test(trimmed)) break;
    if (/^From:\s.+/i.test(trimmed) && kept.length > 0) break;
    if (/^Sent:\s.+/i.test(trimmed) && kept.length > 0) break;
    // Signatures with inline logo images start with a [cid:...] placeholder
    if (/^\[cid:[^\]]*\]/i.test(trimmed) && kept.some((row) => row.trim())) break;
    kept.push(line);
  }

  let result = kept.join("\n");

  // Trim common signature blocks
  const signatureCuts = [
    /\n\s*(Best regards|Kind regards|Regards|Thanks|Thank you),?\s*\n[\s\S]*$/i,
    /\n[^\n]*\b(Jr\.|Sr\.)?\s*Logistics (Specialist|Coordinator|Manager)\b[\s\S]*$/i,
    /\n[^\n]*\bDirect:\s*\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}[\s\S]*$/i,
    /\n[^\n]*\bwww\.[a-z0-9-]+\.[a-z]{2,}[\s\S]*$/i,
    /\n[^\n]*services are provided subject to[\s\S]*$/i,
  ];
  for (const pattern of signatureCuts) {
    const cut = result.replace(pattern, "");
    if (cut.trim().length >= 2) result = cut;
  }

  // Drop inline-image cid placeholders and collapse whitespace
  return result
    .replace(/\[cid:[^\]]*\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function extractReplyText(source) {
  if (!source) return "";
  try {
    const parsed = await simpleParser(source);
    let text = parsed.text ?? "";
    if (!text.trim() && parsed.html) {
      text = String(parsed.html)
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|tr)>/gi, "\n")
        .replace(/<[^>]+>/g, " ");
    }
    return stripQuotedHistory(text).slice(0, 500);
  } catch {
    const raw = messageSourceText(source);
    return stripQuotedHistory(raw.split(/\r?\n\r?\n/).slice(1).join("\n\n")).slice(0, 500);
  }
}

function isFromBroker(fromAddresses, brokerEmail) {
  const needle = normalizeEmail(brokerEmail);
  const domain = needle.split("@")[1];
  return (fromAddresses ?? []).some((addr) => {
    const from = normalizeEmail(addr.address ?? addr);
    if (!from) return false;
    if (from === needle) return true;
    return domain && from.endsWith(`@${domain}`);
  });
}

export async function getSmtpBrokerReplies(
  config,
  { brokerEmail, subject, since, sentMessageIds = [], mailboxEmail }
) {
  const imap = config.imapHost
    ? { imapHost: config.imapHost, imapPort: config.imapPort ?? 993, imapSecure: config.imapSecure !== false }
    : inferImapFromSmtp(config.smtpHost, config.email);
  if (!imap) return [];

  const client = new ImapFlow({
    host: imap.imapHost,
    port: imap.imapPort,
    secure: imap.imapSecure,
    auth: { user: config.email, pass: config.password },
    logger: false,
  });

  const sinceDate =
    since instanceof Date && !Number.isNaN(since.getTime())
      ? since
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const brokerNeedle = normalizeEmail(brokerEmail);
  const replies = [];
  const seenIds = new Set();

  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uidSet = new Set();

      for (const sentId of sentMessageIds) {
        if (!sentId) continue;
        const bare = sentId.replace(/^<|>$/g, "");
        for (const needle of [sentId, bare, `<${bare}>`]) {
          try {
            const headerHits = await client.search({
              header: { "in-reply-to": needle },
              since: sinceDate,
            });
            for (const uid of headerHits ?? []) uidSet.add(uid);
          } catch {
            // some servers reject header search variants
          }
        }
      }

      let uids = [...uidSet];
      if (!uids.length) {
        uids = await client.search({ from: brokerNeedle, since: sinceDate });
      }
      if (!uids?.length) {
        uids = await client.search({ since: sinceDate });
      }
      if (!uids?.length) return [];

      for await (const message of client.fetch(uids, { envelope: true, source: true })) {
        if (!isDirectBrokerReply(message.envelope?.from, brokerNeedle, mailboxEmail ?? config.email)) continue;

        const messageId = message.envelope?.messageId ?? `uid-${message.uid}`;
        if (seenIds.has(messageId)) continue;

        const envelopeSubject = message.envelope?.subject ?? "";
        const related =
          subjectsRelated(subject, envelopeSubject) ||
          referencesOurMessage(message.source, sentMessageIds) ||
          uidSet.has(message.uid);

        if (!related) continue;

        const snippet = await extractReplyText(message.source);
        if (!snippet || snippet.length < 1) continue;

        seenIds.add(messageId);
        replies.push({
          providerMessageId: messageId,
          fromAddress: message.envelope?.from?.[0]?.address ?? brokerEmail,
          snippet,
          receivedAt: message.envelope?.date ?? new Date(),
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return replies.sort((a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime());
}
