import { createHmac } from 'node:crypto';
import type { PrismaClient } from '@ntrack/db';
import { renderJsonTemplate, renderTemplate, safeRequest, SecretBox, type MacroValues } from '@ntrack/shared';

const MAX_STORED_BODY = 2048;

export class DeliveryFailedError extends Error {}

/** Macro values for a delivery. Publisher-owned postbacks never receive the advertiser revenue. */
export const deliveryMacros = async (prisma: PrismaClient, conversionId: string | null, eventName: string, forPublisher: boolean): Promise<MacroValues> => {
  if (!conversionId) return {};
  const c = await prisma.conversion.findUnique({
    where: { id: conversionId },
    include: { campaign: { select: { publicId: true } }, publisher: { select: { publicId: true } }, advertiser: { select: { publicId: true } } },
  });
  if (!c) return {};
  return {
    click_id: c.clickId,
    campaign_id: c.campaign.publicId,
    publisher_id: c.publisher.publicId,
    advertiser_id: c.advertiser.publicId,
    subid1: c.sub1,
    subid2: c.sub2,
    subid3: c.sub3,
    subid4: c.sub4,
    subid5: c.sub5,
    source: c.trafficSource,
    country: c.country,
    device: c.deviceType,
    timestamp: Math.floor(c.convertedAt.getTime() / 1000),
    conversion_id: c.publicId,
    transaction_id: c.transactionId ?? '',
    event: c.event,
    status: eventName.replace('conversion.', '') === 'created' ? c.status : eventName.replace('conversion.', ''),
    revenue: forPublisher ? '' : c.revenue.toString(),
    payout: c.payout.toString(),
    currency: c.currency,
  };
};

/** Sample values for "send test" so partners can verify their endpoint without a real conversion. */
export const SAMPLE_MACROS: MacroValues = {
  click_id: '01J9Z3QK4T8W2M6N7P5R0S1V2X',
  campaign_id: 'cmp_TEST000000',
  publisher_id: 'pub_TEST000000',
  advertiser_id: 'adv_TEST000000',
  subid1: 'test',
  conversion_id: 'cnv_TEST000000',
  transaction_id: 'TEST-ORDER-1',
  event: 'sale',
  status: 'approved',
  revenue: '10.00',
  payout: '7.50',
  currency: 'USD',
  timestamp: Math.floor(Date.now() / 1000),
};

/**
 * Sends one delivery attempt and records the outcome. Throws DeliveryFailedError on a non-2xx or
 * network failure so BullMQ retries with backoff; `finalAttempt` marks the delivery failed.
 */
export const performDelivery = async (
  prisma: PrismaClient,
  secretBox: SecretBox,
  deliveryId: string,
  { finalAttempt, allowPrivateNetwork = false }: { finalAttempt: boolean; allowPrivateNetwork?: boolean }
) => {
  const delivery = await prisma.webhookDelivery.findUnique({ where: { id: deliveryId }, include: { postback: true } });
  if (!delivery) return;
  const { postback } = delivery;
  const macros = delivery.isTest ? SAMPLE_MACROS : await deliveryMacros(prisma, delivery.conversionId, delivery.event, Boolean(postback.publisherId));

  const url = renderTemplate(postback.urlTemplate, macros, { context: 'postback', encoding: 'query' });
  const body = postback.method === 'POST' ? JSON.stringify(postback.bodyTemplate ? renderJsonTemplate(postback.bodyTemplate, macros) : { event: delivery.event, event_id: delivery.eventId, ...macros }) : undefined;

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const headers: Record<string, string> = {
    ...((postback.headers ?? {}) as Record<string, string>),
    'X-NTrack-Event': delivery.event,
    'X-NTrack-Event-Id': delivery.eventId,
    'X-NTrack-Timestamp': timestamp,
  };
  if (body) headers['Content-Type'] = 'application/json';
  if (postback.authTokenEncrypted) headers.Authorization = `Bearer ${secretBox.decrypt(postback.authTokenEncrypted)}`;
  if (postback.hmacSecretEncrypted) {
    const signed = `${timestamp}.${body ?? url}`;
    headers['X-NTrack-Signature'] = `sha256=${createHmac('sha256', secretBox.decrypt(postback.hmacSecretEncrypted)).update(signed).digest('hex')}`;
  }

  const attempts = delivery.attempts + 1;
  try {
    const response = await safeRequest(url, { method: postback.method, headers, body, requireHttps: false, timeoutMs: 10_000, maxBodyBytes: MAX_STORED_BODY, allowPrivateNetwork });
    const ok = response.status >= 200 && response.status < 300;
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        attempts,
        status: ok ? 'success' : finalAttempt ? 'failed' : 'retrying',
        requestUrl: url,
        requestBody: body?.slice(0, MAX_STORED_BODY) ?? null,
        responseStatus: response.status,
        responseBody: response.body.slice(0, MAX_STORED_BODY),
        durationMs: response.durationMs,
        error: ok ? null : `HTTP ${response.status}`,
        lastAttemptAt: new Date(),
      },
    });
    if (!ok) throw new DeliveryFailedError(`HTTP ${response.status}`);
  } catch (error) {
    if (error instanceof DeliveryFailedError) throw error;
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        attempts,
        status: finalAttempt ? 'failed' : 'retrying',
        requestUrl: url,
        requestBody: body?.slice(0, MAX_STORED_BODY) ?? null,
        error: (error as Error).message.slice(0, 500),
        lastAttemptAt: new Date(),
      },
    });
    throw new DeliveryFailedError((error as Error).message);
  }
};
