import { formatMoney } from "./notifications.js";

// The emails sent about an invoice. Plain, single-column HTML that renders
// in every mail client, plus a text version. Everything the issuer or the
// client typed (names, items, notes) is HTML-escaped.

const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

// "2026-10-14" -> "14 Oct 2026"
export function formatDate(isoDate) {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

// 2.5 -> "2.5", 3 -> "3" (as the app shows it)
const formatQuantity = (q) => String(Number(Number(q).toFixed(2)));

function layout({ preheader, heading, intro, amountLine, button, items, currency, notes, footerNote }) {
  const rows = (items ?? [])
    .map(
      (item) => `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #eef0f2;font-size:14px;color:#111827">
            ${escapeHtml(item.description)}
            <div style="font-size:12px;color:#6b7280">${formatQuantity(item.quantity)} × ${formatMoney(item.unit_amount_minor, currency)}</div>
          </td>
          <td style="padding:10px 0;border-bottom:1px solid #eef0f2;font-size:14px;color:#111827;text-align:right;white-space:nowrap">
            ${formatMoney(item.amount_minor, currency)}
          </td>
        </tr>`,
    )
    .join("");
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(heading)}</title></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <span style="display:none;max-height:0;overflow:hidden">${escapeHtml(preheader)}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:32px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;padding:32px">
        <tr><td>
          <p style="margin:0 0 4px;font-size:13px;color:#6b7280">${escapeHtml(heading)}</p>
          <p style="margin:0 0 20px;font-size:28px;font-weight:700;color:#111827">${amountLine}</p>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.5;color:#374151">${intro}</p>
          ${button ? `<a href="${escapeHtml(button.href)}" style="display:inline-block;background:#047857;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:10px">${escapeHtml(button.label)}</a>` : ""}
          ${rows ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px">${rows}</table>` : ""}
          ${notes ? `<p style="margin:20px 0 0;font-size:13px;line-height:1.5;color:#4b5563;white-space:pre-line">${escapeHtml(notes)}</p>` : ""}
        </td></tr>
      </table>
      <p style="margin:16px 0 0;font-size:12px;color:#9ca3af">${footerNote}</p>
    </td></tr>
  </table>
</body></html>`;
}

function itemsText(items, currency) {
  return (items ?? [])
    .map((i) => `- ${i.description}: ${formatQuantity(i.quantity)} x ${formatMoney(i.unit_amount_minor, currency)} = ${formatMoney(i.amount_minor, currency)}`)
    .join("\n");
}

/** The invoice itself, or a reminder about it. */
export function invoiceEmail(invoice, { kind = "invoice", payUrl, message } = {}) {
  const total = formatMoney(invoice.amount_due_minor, invoice.currency_code);
  const due = formatDate(invoice.due_date);
  const from = invoice.issuer_name ?? "A VergePay customer";
  const overdue = invoice.invoice_status === "overdue";
  const greeting = invoice.client?.name ? `Hi ${invoice.client.name},` : "Hi,";

  const subject =
    kind === "reminder"
      ? `Reminder: invoice ${invoice.invoice_number} from ${from} ${overdue ? "is overdue" : `is due ${due}`}`
      : `Invoice ${invoice.invoice_number} from ${from}: ${total} due ${due}`;
  const lead =
    kind === "reminder"
      ? `${overdue ? `This invoice was due on ${due} and is still unpaid.` : `A friendly reminder that this invoice is due on ${due}.`}`
      : `${from} sent you invoice ${invoice.invoice_number}, due on ${due}.`;

  const html = layout({
    preheader: `${total} due ${due}`,
    heading: `Invoice ${invoice.invoice_number} · ${from}`,
    amountLine: escapeHtml(total),
    intro: `${escapeHtml(greeting)}<br>${escapeHtml(lead)}${message ? `<br><br>${escapeHtml(message)}` : ""}<br><br>Pay securely by card, bank transfer or USSD.`,
    button: { href: payUrl, label: `Pay ${total}` },
    items: invoice.items,
    currency: invoice.currency_code,
    notes: invoice.notes,
    footerNote: `Sent by ${escapeHtml(from)} with VergePay. Payments are processed by Flutterwave.`,
  });
  const text = [
    greeting,
    "",
    lead,
    ...(message ? ["", message] : []),
    "",
    itemsText(invoice.items, invoice.currency_code),
    `Total: ${total}`,
    ...(invoice.notes ? ["", invoice.notes] : []),
    "",
    `Pay here: ${payUrl}`,
    "",
    `Sent by ${from} with VergePay.`,
  ].join("\n");
  return { subject, html, text };
}

/** A receipt for whoever paid. */
export function receiptEmail(invoice, { payUrl, paidAt }) {
  const total = formatMoney(invoice.amount_due_minor, invoice.currency_code);
  const from = invoice.issuer_name ?? "A VergePay customer";
  const when = new Date(paidAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Lagos" });
  const subject = `Receipt: you paid ${total} to ${from} (invoice ${invoice.invoice_number})`;
  const html = layout({
    preheader: `Payment received for invoice ${invoice.invoice_number}`,
    heading: `Payment received · Invoice ${invoice.invoice_number}`,
    amountLine: escapeHtml(total),
    intro: `Thank you. Your payment to ${escapeHtml(from)} was received on ${escapeHtml(when)}.`,
    button: { href: payUrl, label: "View receipt" },
    items: invoice.items,
    currency: invoice.currency_code,
    footerNote: "Keep this email for your records. Sent with VergePay.",
  });
  const text = [
    `Thank you. Your payment of ${total} to ${from} for invoice ${invoice.invoice_number} was received on ${when}.`,
    "",
    itemsText(invoice.items, invoice.currency_code),
    "",
    `Receipt: ${payUrl}`,
  ].join("\n");
  return { subject, html, text };
}
