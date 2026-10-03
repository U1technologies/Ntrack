import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { isPrivateAddress, validateOutboundUrl } from './url-safety';

/**
 * SSRF-safe outbound HTTP for everything NTrack calls on behalf of users: postbacks, webhooks,
 * domain health checks and the redirect compatibility tester.
 *
 * Address validation happens inside the socket's DNS lookup, so the IP that is checked is the IP
 * that is connected to (no DNS-rebinding window). Redirects are never followed automatically;
 * callers that need a redirect chain walk it hop by hop, re-validating each hop.
 */

export interface SafeRequestOptions {
  method?: 'GET' | 'POST' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
  requireHttps?: boolean;
  /** Test-only escape hatch for local fixtures. Never enable from user input. */
  allowPrivateNetwork?: boolean;
}

export interface SafeResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  durationMs: number;
  remoteAddress: string;
  certificateValidTo: Date | null;
}

export class SafeRequestError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_url' | 'blocked_address' | 'timeout' | 'network_error'
  ) {
    super(message);
    this.name = 'SafeRequestError';
  }
}

const guardedLookup =
  (allowPrivate: boolean): LookupFunction =>
  (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, '', 0);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses as unknown as string, family: 4 }];
      const blocked = !allowPrivate && list.some((entry) => isPrivateAddress(entry.address));
      if (blocked || list.length === 0) {
        return callback(new SafeRequestError(`Blocked request to private address for ${hostname}`, 'blocked_address'), '', 0);
      }
      if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
      const first = list[0]!;
      return callback(null, first.address, first.family);
    });
  };

export const safeRequest = (rawUrl: string, options: SafeRequestOptions = {}): Promise<SafeResponse> => {
  const { method = 'GET', headers = {}, body, timeoutMs = 10_000, maxBodyBytes = 64 * 1024, requireHttps = true, allowPrivateNetwork = false } = options;
  const validated = validateOutboundUrl(rawUrl, { requireHttps });
  if (!validated.ok && !(allowPrivateNetwork && validated.reason === 'private_address')) {
    return Promise.reject(new SafeRequestError(`Outbound URL rejected: ${validated.reason}`, 'invalid_url'));
  }
  const url = new URL(rawUrl);
  const transport = url.protocol === 'https:' ? https : http;
  const startedAt = performance.now();

  return new Promise<SafeResponse>((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method,
        headers: { 'user-agent': 'NTrack/1.0 (+https://nextagmedia.com/ntrack)', ...headers },
        lookup: guardedLookup(allowPrivateNetwork),
        timeout: timeoutMs,
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const socket = response.socket as TLSSocket;
        const certificate = typeof socket.getPeerCertificate === 'function' ? socket.getPeerCertificate() : null;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size <= maxBodyBytes) chunks.push(chunk);
        });
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            durationMs: Math.round(performance.now() - startedAt),
            remoteAddress: socket.remoteAddress ?? '',
            certificateValidTo: certificate?.valid_to ? new Date(certificate.valid_to) : null,
          })
        );
        response.on('error', (error) => reject(new SafeRequestError(error.message, 'network_error')));
      }
    );
    request.on('timeout', () => request.destroy(new SafeRequestError(`Request timed out after ${timeoutMs}ms`, 'timeout')));
    request.on('error', (error) => reject(error instanceof SafeRequestError ? error : new SafeRequestError(error.message, 'network_error')));
    if (body) request.write(body);
    request.end();
  });
};
