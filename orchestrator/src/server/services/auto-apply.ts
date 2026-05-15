import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import net from "node:net";
import tls from "node:tls";
import { badRequest, serviceUnavailable, upstreamError } from "@infra/errors";
import { logger } from "@infra/logger";
import { getPdfPath } from "@server/services/pdf";
import { getProfile } from "@server/services/profile";
import type { Job, ResumeProfile } from "@shared/types";

type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  pass: string | null;
  from: string;
  fromName: string;
  timeoutMs: number;
};

type MailAttachment = {
  filename: string;
  contentType: string;
  content: Buffer;
};

type MailMessage = {
  from: string;
  fromName: string;
  to: string;
  subject: string;
  text: string;
  attachments: MailAttachment[];
};

export type AutoApplyResult = {
  mode: "email";
  recipient: string;
  subject: string;
  messageId: string;
  attachedResume: boolean;
};

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeEmail(value: string): string | null {
  const match = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : null;
}

export function resolveAutoApplyRecipient(
  job: Pick<Job, "applicationLink" | "jobDescription" | "jobBrief" | "emails">,
): string | null {
  const applicationLink = cleanString(job.applicationLink);
  if (applicationLink?.toLowerCase().startsWith("mailto:")) {
    const parsed = new URL(applicationLink);
    return normalizeEmail(decodeURIComponent(parsed.pathname));
  }

  for (const candidate of [
    job.applicationLink,
    job.emails,
    job.jobDescription,
    job.jobBrief,
  ]) {
    const email = normalizeEmail(candidate ?? "");
    if (email) return email;
  }

  return null;
}

function getSmtpConfig(profile: ResumeProfile | null): SmtpConfig {
  const host = cleanString(process.env.AUTO_APPLY_SMTP_HOST);
  if (!host) {
    throw serviceUnavailable(
      "Auto-apply email is not configured. Set AUTO_APPLY_SMTP_HOST to enable real application sending.",
    );
  }

  const user = cleanString(process.env.AUTO_APPLY_SMTP_USER);
  const pass = cleanString(process.env.AUTO_APPLY_SMTP_PASS);
  const from =
    cleanString(process.env.AUTO_APPLY_EMAIL_FROM) ??
    cleanString(profile?.basics?.email) ??
    user;
  if (!from) {
    throw serviceUnavailable(
      "Auto-apply email needs AUTO_APPLY_EMAIL_FROM, AUTO_APPLY_SMTP_USER, or a profile email.",
    );
  }

  const port = Number.parseInt(process.env.AUTO_APPLY_SMTP_PORT ?? "", 10);
  const secureRaw = cleanString(
    process.env.AUTO_APPLY_SMTP_SECURE,
  )?.toLowerCase();
  const secure = secureRaw
    ? ["1", "true", "yes"].includes(secureRaw)
    : port === 465;
  const timeoutMs = Number.parseInt(
    process.env.AUTO_APPLY_SMTP_TIMEOUT_MS ?? "",
    10,
  );

  return {
    host,
    port: Number.isFinite(port) && port > 0 ? port : secure ? 465 : 587,
    secure,
    user,
    pass,
    from,
    fromName:
      cleanString(process.env.AUTO_APPLY_EMAIL_FROM_NAME) ??
      cleanString(profile?.basics?.name) ??
      "Job Ops",
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000,
  };
}

function buildBody(job: Job, profile: ResumeProfile | null): string {
  const name = cleanString(profile?.basics?.name) ?? "Candidate";
  const headline =
    cleanString(job.tailoredHeadline) ??
    cleanString(profile?.basics?.headline) ??
    cleanString(profile?.basics?.label);
  const summary =
    cleanString(job.tailoredSummary) ??
    cleanString(profile?.basics?.summary) ??
    cleanString(profile?.sections?.summary?.content);
  const lines = [
    `Hello ${job.employer} team,`,
    "",
    `I am applying for the ${job.title} role.`,
    ...(headline ? ["", headline] : []),
    ...(summary ? ["", stripHtml(summary)] : []),
    "",
    "I have attached my tailored resume for your review.",
    "",
    "Best regards,",
    name,
  ];
  return lines.join("\n");
}

function encodeHeader(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 127) {
      return `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=`;
    }
  }
  return value;
}

function formatAddress(email: string, name: string): string {
  const escapedName = name.replace(/["\\]/g, "");
  return `"${encodeHeader(escapedName)}" <${email}>`;
}

function buildMimeMessage(message: MailMessage): string {
  const boundary = `jobops-${createHash("sha256")
    .update(`${Date.now()}-${message.to}-${message.subject}`)
    .digest("hex")
    .slice(0, 24)}`;
  const headers = [
    `From: ${formatAddress(message.from, message.fromName)}`,
    `To: ${message.to}`,
    `Subject: ${encodeHeader(message.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];
  const parts = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    message.text,
  ];

  for (const attachment of message.attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      "",
      attachment.content
        .toString("base64")
        .replace(/.{1,76}/g, "$&\r\n")
        .trim(),
    );
  }

  parts.push(`--${boundary}--`, "");
  return `${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}`;
}

async function readResponse(
  socket: net.Socket | tls.TLSSocket,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const last = lines.at(-1);
      if (last && /^\d{3} /.test(last)) {
        cleanup();
        resolve(buffer);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

async function expectSmtp(
  socket: net.Socket | tls.TLSSocket,
  codes: number[],
): Promise<string> {
  const response = await readResponse(socket);
  const code = Number.parseInt(response.slice(0, 3), 10);
  if (!codes.includes(code)) {
    throw upstreamError("SMTP server rejected auto-apply email.", {
      code,
      response,
    });
  }
  return response;
}

async function command(
  socket: net.Socket | tls.TLSSocket,
  value: string,
  codes: number[],
): Promise<string> {
  socket.write(`${value}\r\n`);
  return expectSmtp(socket, codes);
}

function connectSmtp(config: SmtpConfig): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = config.secure
      ? tls.connect(config.port, config.host, { servername: config.host })
      : net.connect(config.port, config.host);
    socket.setTimeout(config.timeoutMs);
    socket.once(config.secure ? "secureConnect" : "connect", () =>
      resolve(socket),
    );
    socket.once("timeout", () => {
      socket.destroy();
      reject(upstreamError("SMTP connection timed out."));
    });
    socket.once("error", reject);
  });
}

async function startTls(
  socket: net.Socket,
  config: SmtpConfig,
): Promise<tls.TLSSocket> {
  await command(socket, "STARTTLS", [220]);
  return new Promise((resolve, reject) => {
    const secureSocket = tls.connect({ socket, servername: config.host });
    secureSocket.once("secureConnect", () => resolve(secureSocket));
    secureSocket.once("error", reject);
  });
}

async function sendSmtpMail(
  config: SmtpConfig,
  message: MailMessage,
): Promise<string> {
  let socket = await connectSmtp(config);
  try {
    await expectSmtp(socket, [220]);
    await command(
      socket,
      `EHLO ${process.env.AUTO_APPLY_SMTP_HELO ?? "jobops.local"}`,
      [250],
    );
    if (!config.secure && process.env.AUTO_APPLY_SMTP_STARTTLS !== "0") {
      socket = await startTls(socket as net.Socket, config);
      await command(
        socket,
        `EHLO ${process.env.AUTO_APPLY_SMTP_HELO ?? "jobops.local"}`,
        [250],
      );
    }
    if (config.user && config.pass) {
      await command(socket, "AUTH LOGIN", [334]);
      await command(socket, Buffer.from(config.user).toString("base64"), [334]);
      await command(socket, Buffer.from(config.pass).toString("base64"), [235]);
    }
    await command(socket, `MAIL FROM:<${message.from}>`, [250]);
    await command(socket, `RCPT TO:<${message.to}>`, [250, 251]);
    await command(socket, "DATA", [354]);
    socket.write(`${buildMimeMessage(message)}\r\n.\r\n`);
    await expectSmtp(socket, [250]);
    await command(socket, "QUIT", [221]);
    return createHash("sha256")
      .update(`${message.to}:${message.subject}:${Date.now()}`)
      .digest("hex");
  } finally {
    socket.destroy();
  }
}

async function buildAttachments(job: Job): Promise<MailAttachment[]> {
  if (!job.pdfPath) return [];
  const pdfPath = getPdfPath(job.id);
  if (!existsSync(pdfPath)) return [];
  return [
    {
      filename:
        `${job.employer}-${job.title}-resume.pdf`
          .replace(/[^a-z0-9._-]+/gi, "-")
          .replace(/^-+|-+$/g, "") || "resume.pdf",
      contentType: "application/pdf",
      content: await readFile(pdfPath),
    },
  ];
}

export async function sendAutoApplication(job: Job): Promise<AutoApplyResult> {
  if (job.status !== "ready") {
    throw badRequest("Only ready jobs can be auto-applied.");
  }

  if (
    job.pdfRegenerating ||
    job.pdfFreshness === "regenerating" ||
    job.pdfFreshness === "stale"
  ) {
    throw badRequest(
      "Auto-apply needs a current generated resume PDF or an uploaded resume PDF before sending.",
    );
  }

  const recipient = resolveAutoApplyRecipient(job);
  if (!recipient) {
    throw badRequest(
      "Auto-apply currently supports jobs with an application email or mailto application link.",
    );
  }

  const profile = await getProfile().catch((error) => {
    logger.warn(
      "Auto-apply could not load profile; continuing with SMTP sender config",
      { jobId: job.id, error },
    );
    return null;
  });
  const config = getSmtpConfig(profile);
  const subject = `Application for ${job.title} at ${job.employer}`;
  const attachments = await buildAttachments(job);
  if (attachments.length === 0) {
    throw badRequest(
      "Auto-apply needs a generated or uploaded resume PDF before sending.",
    );
  }
  const messageId = await sendSmtpMail(config, {
    from: config.from,
    fromName: config.fromName,
    to: recipient,
    subject,
    text: buildBody(job, profile),
    attachments,
  });

  return {
    mode: "email",
    recipient,
    subject,
    messageId,
    attachedResume: attachments.length > 0,
  };
}
