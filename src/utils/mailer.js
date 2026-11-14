/**
 * Mailer — delivers invitation emails.
 *
 * Transports (MAIL_TRANSPORT):
 *   - "console" (default, safe for development): prints the full invitation
 *     email including the acceptance link to the server console. No real
 *     email is sent.
 *   - "smtp": sends real email through SMTP_HOST / SMTP_PORT / SMTP_USER /
 *     SMTP_PASS using nodemailer. Nodemailer is imported dynamically so it
 *     stays an OPTIONAL dependency — install it with: npm i nodemailer
 *
 * sendInvitationEmail never throws: it always resolves to
 *   { sent: boolean, mode: 'console' | 'smtp', error: string | null }
 * so callers can report the REAL delivery outcome to the client.
 * Delivery errors are logged server-side; secrets are never included.
 */

const SUBJECT = "You're invited to join the Help Desk workspace";

function getTransport() {
  return String(process.env.MAIL_TRANSPORT || "console").toLowerCase().trim();
}

function buildInvitationLink(token) {
  const base = String(
    process.env.FRONTEND_URL || process.env.APP_URL || "http://localhost:5173",
  ).replace(/\/+$/, "");
  return `${base}/accept-invitation?token=${encodeURIComponent(token)}`;
}

function buildBodyText({ to, role, team, link, expiresAt }) {
  return [
    "Hi,",
    "",
    "You have been invited to join the Help Desk support workspace.",
    "",
    `Email:   ${to}`,
    `Role:    ${role}`,
    `Team:    ${team}`,
    `Expires: ${expiresAt || "in 7 days"}`,
    "",
    "Accept your invitation:",
    link,
    "",
    "This invitation link expires on the date above. If you did not expect",
    "this email, you can safely ignore it.",
  ].join("\n");
}

function logInvitationToConsole({ to, link, expiresAt, note }) {
  const banner = "============================================================";
  console.log(
    "\n" +
      `================ INVITATION EMAIL (${note}) ================\n` +
      `To:      ${to}\n` +
      `Subject: ${SUBJECT}\n` +
      `Link:    ${link}\n` +
      `Expires: ${expiresAt || "n/a"}\n` +
      banner,
  );
}

/**
 * Send an invitation email. Resolves to { sent, mode, error }.
 */
export async function sendInvitationEmail({ to, role, team, token, expiresAt }) {
  const link = buildInvitationLink(token);
  const bodyText = buildBodyText({ to, role, team, link, expiresAt });

  if (getTransport() === "smtp") {
    const host = process.env.SMTP_HOST;
    const from = process.env.MAIL_FROM;

    if (!host || !from) {
      const error =
        "MAIL_TRANSPORT=smtp but SMTP_HOST and MAIL_FROM are not configured.";
      console.error(`[mailer] ${error} Falling back to the console transport.`);
      logInvitationToConsole({ to, link, expiresAt, note: "SMTP not configured" });
      return { sent: false, mode: "console", error };
    }

    try {
      // Nodemailer is optional — imported only when SMTP delivery is requested.
      const { default: nodemailer } = await import("nodemailer");
      const transport = nodemailer.createTransport({
        host,
        port: parseInt(process.env.SMTP_PORT, 10) || 587,
        secure: String(process.env.SMTP_SECURE || "").toLowerCase() === "true",
        auth: process.env.SMTP_USER
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
          : undefined,
      });

      await transport.sendMail({
        from,
        to,
        subject: SUBJECT,
        text: bodyText,
        html: bodyText
          .split("\n")
          .map((line) =>
            line === link
              ? `<p><a href="${link}">Accept your invitation</a></p>`
              : `<p style="margin:0">${line.replace(/</g, "&lt;") || "&nbsp;"}</p>`,
          )
          .join(""),
      });

      return { sent: true, mode: "smtp", error: null };
    } catch (err) {
      // Log the REAL send error server-side (message only — no credentials).
      console.error("[mailer] SMTP delivery failed:", err.message);
      // Safety net: the invite is never lost — the link is still logged.
      logInvitationToConsole({ to, link, expiresAt, note: "SMTP failed" });
      return {
        sent: false,
        mode: "smtp",
        error: `Email delivery failed: ${err.message}`,
      };
    }
  }

  // Default development transport: log the invitation link so it can be
  // opened locally while no real email provider is configured.
  logInvitationToConsole({ to, link, expiresAt, note: "dev console transport" });
  return { sent: true, mode: "console", error: null };
}
