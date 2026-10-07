// Emails about the customer's account (not invoices): a one-time code to
// reset their password, or to confirm a new email address. Plain and short,
// with the code large enough to read on a phone.

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

function codeEmail({ preheader, heading, intro, code, minutes, ignoreNote }) {
  const html = `<!doctype html>
<html><body style="margin:0;background:#f4f6f5;font-family:Arial,Helvetica,sans-serif;color:#1f2933">
<span style="display:none">${escapeHtml(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;padding:28px">
      <tr><td style="font-weight:700;color:#047857;font-size:18px">VergePay</td></tr>
      <tr><td style="padding-top:16px;font-size:20px;font-weight:600">${escapeHtml(heading)}</td></tr>
      <tr><td style="padding-top:8px;font-size:14px;line-height:1.5;color:#52606d">${escapeHtml(intro)}</td></tr>
      <tr><td style="padding:20px 0;font-size:32px;font-weight:700;letter-spacing:8px;color:#064e3b">${escapeHtml(code)}</td></tr>
      <tr><td style="font-size:13px;color:#52606d">It expires in ${minutes} minutes. Never share it with anyone, including anyone who says they're from VergePay.</td></tr>
      <tr><td style="padding-top:16px;font-size:13px;color:#52606d">${escapeHtml(ignoreNote)}</td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
  const text = `${heading}

${intro}

${code}

It expires in ${minutes} minutes. Never share it with anyone, including anyone who says they're from VergePay.

${ignoreNote}`;
  return { html, text };
}

/** The 6-digit code for resetting a password. */
export function passwordResetEmail({ code, minutes }) {
  return {
    subject: `${code} is your VergePay password reset code`,
    ...codeEmail({
      preheader: `Your code is ${code}`,
      heading: "Reset your password",
      intro: "Enter this code in VergePay to choose a new password:",
      code,
      minutes,
      ignoreNote: "If you didn't ask to reset your password, you can ignore this email: your password hasn't changed.",
    }),
  };
}

/** The 6-digit code for confirming a new email address. */
export function emailChangeEmail({ code, minutes }) {
  return {
    subject: `${code} is your VergePay email confirmation code`,
    ...codeEmail({
      preheader: `Your code is ${code}`,
      heading: "Confirm your new email address",
      intro: "Enter this code in VergePay to use this address for your account:",
      code,
      minutes,
      ignoreNote: "If you didn't ask to change your email address, you can ignore this email.",
    }),
  };
}
