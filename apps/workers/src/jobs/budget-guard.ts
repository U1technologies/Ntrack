import type { ConfigPublisher } from '@ntrack/config-sync';
import type { Logger } from '../logger';

export interface ExhaustedCampaign {
  campaignId: string;
  organizationId: string;
  advertiserId: string;
  name: string;
}

/**
 * Stops paid traffic once a campaign's monthly or total budget is used up. The tracker reads the
 * `budgetExhausted` flag from the campaign snapshot, so enforcement lags spend by at most one run
 * of this job (every minute) plus conversion processing time.
 */
export const runBudgetGuard = async (
  publisher: ConfigPublisher,
  log: Logger,
  onExhausted?: (campaign: ExhaustedCampaign) => Promise<void>
) => {
  const result = await publisher.refreshBudgets();
  for (const campaign of result.exhausted) {
    log.warn(campaign, 'campaign budget exhausted; tracker now treats clicks as budget_reached');
    if (onExhausted) {
      await onExhausted(campaign).catch((error: unknown) => log.error({ err: error, campaignId: campaign.campaignId }, 'budget notification failed'));
    }
  }
  return { checked: result.checked, changed: result.changed, exhausted: result.exhausted.length };
};
