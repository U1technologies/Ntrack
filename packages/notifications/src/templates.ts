const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const FOOTER = 'You receive this because of your NTrack notification settings. Change them under Notifications → Preferences.';

/** Plain, escaped transactional email. All dynamic values are escaped; links are only console URLs. */
export const renderNotificationEmail = (input: { title: string; body: string; link: string; typeLabel: string }) => {
  const subject = `[NTrack] ${input.title}`.replace(/[\r\n]+/g, ' ').slice(0, 200);
  const text = [input.title, '', input.body, input.link ? `\nOpen in NTrack: ${input.link}` : '', '', '--', FOOTER].join('\n');
  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;line-height:1.5">
<p style="font-size:12px;color:#6b7280;margin:0 0 8px">${escapeHtml(input.typeLabel)}</p>
<h2 style="font-size:18px;margin:0 0 12px">${escapeHtml(input.title)}</h2>
${input.body ? `<p style="white-space:pre-line">${escapeHtml(input.body)}</p>` : ''}
${input.link ? `<p><a href="${escapeHtml(input.link)}" style="color:#4f46e5">Open in NTrack</a></p>` : ''}
<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0 8px"><p style="font-size:12px;color:#6b7280">${escapeHtml(FOOTER)}</p>
</body></html>`;
  return { subject, text, html };
};

export const renderReportEmail = (input: { reportName: string; rangeLabel: string; rowCount: number }) => {
  const subject = `[NTrack] Scheduled report: ${input.reportName}`.replace(/[\r\n]+/g, ' ').slice(0, 200);
  const text = `Your scheduled report "${input.reportName}" for ${input.rangeLabel} is attached (${input.rowCount} rows, CSV and Excel).\n\n--\n${FOOTER}`;
  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#1f2937">
<p>Your scheduled report <strong>${escapeHtml(input.reportName)}</strong> for ${escapeHtml(input.rangeLabel)} is attached (${input.rowCount} rows, CSV and Excel).</p>
<p style="font-size:12px;color:#6b7280">${escapeHtml(FOOTER)}</p></body></html>`;
  return { subject, text, html };
};

/**
 * Account emails (invitations, password reset). Same escaping rules as notifications; the button
 * link is the only URL and it is always built by the API from the configured console origin.
 */
const ACCOUNT_FOOTER = 'This is an account email from NTrack by Nextagmedia. If you did not expect it, you can ignore it; nothing changes unless you use the link.';

const renderAccountEmail = (input: { subject: string; heading: string; paragraphs: string[]; button?: { label: string; url: string } }) => {
  const subject = `[NTrack] ${input.subject}`.replace(/[\r\n]+/g, ' ').slice(0, 200);
  const text = [input.heading, '', ...input.paragraphs, input.button ? `\n${input.button.label}: ${input.button.url}` : '', '', '--', ACCOUNT_FOOTER].join('\n');
  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;line-height:1.5">
<h2 style="font-size:18px;margin:0 0 12px">${escapeHtml(input.heading)}</h2>
${input.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n')}
${input.button ? `<p><a href="${escapeHtml(input.button.url)}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#4f46e5;color:#ffffff;text-decoration:none;font-weight:600">${escapeHtml(input.button.label)}</a></p><p style="font-size:12px;color:#6b7280;word-break:break-all">${escapeHtml(input.button.url)}</p>` : ''}
<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0 8px"><p style="font-size:12px;color:#6b7280">${escapeHtml(ACCOUNT_FOOTER)}</p>
</body></html>`;
  return { subject, text, html };
};

export const renderInvitationEmail = (input: { organizationName: string; inviterName: string; roleName: string; url: string; expiresInDays: number }) =>
  renderAccountEmail({
    subject: `You are invited to ${input.organizationName}`,
    heading: `Join ${input.organizationName} on NTrack`,
    paragraphs: [
      `${input.inviterName} invited you to ${input.organizationName} as ${input.roleName}.`,
      `The link works once and expires in ${input.expiresInDays} days.`,
    ],
    button: { label: 'Accept invitation', url: input.url },
  });

export const renderPasswordResetEmail = (input: { url: string; expiresInMinutes: number }) =>
  renderAccountEmail({
    subject: 'Reset your password',
    heading: 'Reset your NTrack password',
    paragraphs: [
      'Someone asked to reset the password for this email address. If it was you, use the button below.',
      `The link works once and expires in ${input.expiresInMinutes} minutes. If you did not ask for this, ignore this email; your password stays the same.`,
    ],
    button: { label: 'Choose a new password', url: input.url },
  });

export const renderPasswordChangedEmail = (input: { when: string }) =>
  renderAccountEmail({
    subject: 'Your password was changed',
    heading: 'Your NTrack password was changed',
    paragraphs: [
      `The password for this account was changed on ${input.when} (UTC). Other signed-in sessions were signed out.`,
      'If you did not do this, reset your password now and tell your NTrack administrator.',
    ],
  });
