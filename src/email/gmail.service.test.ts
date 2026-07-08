import { describe, expect, it } from "vitest";
import { buildRawGmailMessage } from "./gmail.service";

function decode(raw: string): string {
  return Buffer.from(raw, "base64url").toString("utf8");
}

describe("buildRawGmailMessage", () => {
  it("includes To/From/Subject headers and the HTML body", () => {
    const raw = buildRawGmailMessage("broker@example.com", "me@cargosignal.io", {
      to: "broker@example.com",
      subject: "Re: Dallas -> Atlanta load",
      bodyHtml: "<p>Still available?</p>",
    });

    const decoded = decode(raw);
    expect(decoded).toContain("To: broker@example.com");
    expect(decoded).toContain("From: me@cargosignal.io");
    expect(decoded).toContain("Subject: Re: Dallas -> Atlanta load");
    expect(decoded).toContain("<p>Still available?</p>");
  });

  it("adds In-Reply-To/References headers when replying within a thread", () => {
    const raw = buildRawGmailMessage("broker@example.com", "me@cargosignal.io", {
      to: "broker@example.com",
      subject: "Re: load",
      bodyHtml: "<p>Following up</p>",
      inReplyToMessageId: "<abc123@mail.gmail.com>",
    });

    const decoded = decode(raw);
    expect(decoded).toContain("In-Reply-To: <abc123@mail.gmail.com>");
    expect(decoded).toContain("References: <abc123@mail.gmail.com>");
  });

  it("omits threading headers for a fresh message", () => {
    const raw = buildRawGmailMessage("broker@example.com", "me@cargosignal.io", {
      to: "broker@example.com",
      subject: "New inquiry",
      bodyHtml: "<p>Hi</p>",
    });

    expect(decode(raw)).not.toContain("In-Reply-To");
  });
});
