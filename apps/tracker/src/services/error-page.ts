const MESSAGES: Record<number, { title: string; body: string }> = {
  400: { title: 'Invalid tracking link', body: 'This tracking link is missing a valid destination.' },
  404: { title: 'Link not found', body: 'This tracking link does not exist or is no longer active.' },
  410: { title: 'Offer unavailable', body: 'This offer is not available right now.' },
  503: { title: 'Temporarily unavailable', body: 'Please try again in a moment.' },
};

/** Minimal static page. Never echoes request data or reveals the configured destination. */
export const errorPage = (status: number): string => {
  const { title, body } = MESSAGES[status] ?? MESSAGES[404]!;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${title}</title><style>body{font-family:system-ui,sans-serif;background:#f6f8fb;color:#0f1b33;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:420px;padding:32px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{color:#56607a;margin:0}</style></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
};
