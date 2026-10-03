import { createHash } from 'node:crypto';
import type { Conversion } from '@ntrack/db';
import type { PostbackEvent } from '@ntrack/shared';
import type { ConversionDeps } from './processor';

/** Stable per (postback, conversion, event): receivers can use it to drop retried deliveries. */
export const deliveryEventId = (postbackId: string, conversionId: string, event: string) =>
  `evt_${createHash('sha256').update(`${postbackId}:${conversionId}:${event}`).digest('base64url').slice(0, 24)}`;

export const POSTBACK_JOB_OPTIONS = {
  attempts: 8,
  backoff: { type: 'exponential' as const, delay: 30_000 },
  removeOnComplete: 1000,
  removeOnFail: 5000,
};

/**
 * Queues one delivery per matching active postback: organization-wide postbacks (optionally for
 * one campaign) and postbacks owned by the conversion's publisher.
 */
export const dispatchPostbacks = async (deps: Pick<ConversionDeps, 'prisma' | 'postbackQueue' | 'log'>, conversion: Conversion, event: PostbackEvent) => {
  const postbacks = await deps.prisma.postback.findMany({
    where: {
      organizationId: conversion.organizationId,
      active: true,
      events: { has: event },
      AND: [{ OR: [{ publisherId: null }, { publisherId: conversion.publisherId }] }, { OR: [{ campaignId: null }, { campaignId: conversion.campaignId }] }],
    },
    select: { id: true, method: true, urlTemplate: true },
  });
  for (const postback of postbacks) {
    const eventId = deliveryEventId(postback.id, conversion.id, event);
    const delivery = await deps.prisma.webhookDelivery.create({
      data: {
        organizationId: conversion.organizationId,
        postbackId: postback.id,
        conversionId: conversion.id,
        eventId,
        event,
        requestMethod: postback.method,
        requestUrl: postback.urlTemplate,
      },
    });
    await deps.postbackQueue.add('deliver', { deliveryId: delivery.id }, { ...POSTBACK_JOB_OPTIONS, jobId: delivery.id });
  }
  return postbacks.length;
};
