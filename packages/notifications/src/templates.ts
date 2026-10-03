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
