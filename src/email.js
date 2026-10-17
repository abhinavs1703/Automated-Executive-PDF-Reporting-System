import fs from 'node:fs/promises';
import { Resend } from 'resend';
import { config } from './config.js';
import { formatMoney } from './format.js';

// Limits documented by Resend for a single send.
const MAX_RECIPIENTS = 50;
const MAX_ENCODED_ATTACHMENT_BYTES = 40_000_000; // Resend: 40 MB per email (after base64 encoding)

const ADDRESS_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
// "Reports <reports@example.com>" - the display-name form Resend accepts for `from`.
const NAMED_ADDRESS_PATTERN = /^([^<>\r\n]+?)\s*<([^<>\s]+)>$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** Raised when Resend (or the network) fails to accept an email. */
export class EmailDeliveryError extends Error {
  constructor(message, { code = null, statusCode = null } = {}) {
    super(message);
    this.name = 'EmailDeliveryError';
    this.code = code; // Resend error name, e.g. "validation_error"
    this.statusCode = statusCode; // HTTP status reported by Resend, when known
  }
}

/** Never let an API key end up in an error message, log line or database row. */
function redact(text, apiKey) {
  const message = String(text ?? '');
  return apiKey ? message.split(apiKey).join('[redacted]') : message;
}

function isValidSender(from) {
  if (CONTROL_CHARACTERS.test(from)) return false;
  const named = NAMED_ADDRESS_PATTERN.exec(from);
  return ADDRESS_PATTERN.test(named ? named[2] : from);
}

function validateEmailSettings({ apiKey, from, to }) {
  if (!apiKey) throw new Error('Resend is not configured: set RESEND_API_KEY in your local .env file.');
  if (!from) throw new Error('Resend is not configured: set EMAIL_FROM to a sender address on a verified domain (or onboarding@resend.dev for testing).');
  if (!Array.isArray(to) || to.length === 0) throw new Error('Set EMAIL_TO to at least one recipient email address.');
  if (to.length > MAX_RECIPIENTS) throw new Error(`Resend accepts at most ${MAX_RECIPIENTS} recipients per email; EMAIL_TO has ${to.length}.`);
  if (!isValidSender(from)) throw new Error(`Invalid email address configuration: ${from}`);
  for (const address of to) {
    if (CONTROL_CHARACTERS.test(address) || !ADDRESS_PATTERN.test(address)) {
      throw new Error(`Invalid email address configuration: ${address}`);
    }
  }
}

/**
 * Send a generated PDF report through Resend.
 *
 * Resend's SDK does NOT throw for API-level failures (invalid key, unverified domain,
 * rate limit, ...): it resolves with `{ data: null, error }`. This function therefore
 * treats any `error`, and any response without an email id, as a failed delivery and
 * throws, so the caller never records an email as sent unless Resend accepted it.
 *
 * A client may be injected for tests (any object with `emails.send(payload)`), or a
 * `createClient(apiKey)` factory; production uses the official `resend` SDK.
 *
 * Resolves with { accepted: true, statusCode, recipientCount, filename, id }.
 * `statusCode` is null because the SDK does not expose the HTTP status of a successful
 * send; `id` is the Resend email id (useful for looking the message up in the dashboard).
 */
export async function sendReportEmail({
  pdfPath,
  reportData,
  to = config.emailTo,
  from = config.emailFrom,
  apiKey = config.resendApiKey,
  client,
  createClient = (key) => new Resend(key),
} = {}) {
  validateEmailSettings({ apiKey, from, to });
  if (!pdfPath) throw new Error('pdfPath is required to send a report attachment.');
  if (!reportData?.metadata?.reportStart || !reportData?.metadata?.reportEnd) {
    throw new Error('reportData is missing reporting-period metadata.');
  }

  const pdf = await fs.readFile(pdfPath);
  if (pdf.length < 5 || pdf.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('The report attachment is not a valid PDF file.');
  }
  // base64 string: unambiguous in the SDK's JSON request body (a raw Buffer would be
  // serialised as {"type":"Buffer","data":[...]}, which is far larger).
  const content = pdf.toString('base64');
  if (content.length > MAX_ENCODED_ATTACHMENT_BYTES) {
    throw new Error('The report PDF is too large to email (Resend allows 40 MB per email, including encoding).');
  }

  const { metadata, summary } = reportData;
  const filename = `executive-report-${metadata.reportStart}-to-${metadata.reportEnd}.pdf`;
  const payload = {
    from,
    to: to.length === 1 ? to[0] : to,
    subject: `Weekly Executive Business Report: ${metadata.reportStart} to ${metadata.reportEnd}`,
    text: [
      `Please find attached the executive business report for ${metadata.periodLabel}.`,
      '',
      `Revenue: ${formatMoney(summary.totalRevenue, metadata.currency)}`,
      `Orders: ${summary.totalOrders}`,
      `Average order value: ${formatMoney(summary.averageOrderValue, metadata.currency)}`,
      '',
      'This report was generated automatically.',
    ].join('\n'),
    attachments: [{ filename, content, contentType: 'application/pdf' }],
  };

  // Created only now, after validation: `new Resend()` throws without a key, and email is
  // disabled by default, so nothing may construct a client at import time.
  const resend = client ?? createClient(apiKey);

  let response;
  try {
    response = await resend.emails.send(payload);
  } catch (error) {
    // Network failure, abort, or an SDK-internal exception.
    throw new EmailDeliveryError(`Resend request failed: ${redact(error?.message || 'unknown error', apiKey)}`);
  }

  if (response?.error) {
    const { name, message, statusCode } = response.error;
    const detail = [statusCode ? `HTTP ${statusCode}` : null, name].filter(Boolean).join(', ');
    throw new EmailDeliveryError(
      `Resend rejected the email${detail ? ` (${detail})` : ''}: ${redact(message || 'no details provided', apiKey)}`,
      { code: name ?? null, statusCode: statusCode ?? null },
    );
  }
  if (!response?.data?.id) {
    // No error but also no confirmation: do not claim success.
    throw new EmailDeliveryError('Resend returned no email id, so delivery could not be confirmed.');
  }

  return {
    accepted: true,
    statusCode: null,
    recipientCount: to.length,
    filename,
    id: response.data.id,
  };
}
