import type { ConversionTrackingMethod } from '@ntrack/shared';

/**
 * Conversion code an advertiser places on their side, for each tracking method. `{click_id}`
 * stands for the NTrack click ID the advertiser stored from the landing page URL; `{order_id}`
 * and `{order_total}` are the advertiser's own values.
 */
/** Placeholder shown instead of the advertiser's postback token to people who may not manage it. */
export const TOKEN_PLACEHOLDER = 'YOUR_POSTBACK_TOKEN';

/** The postback token is a secret: only roles that manage advertisers or postbacks see it. */
export const canRevealPostbackToken = (permissions: Set<string>) => permissions.has('advertisers.manage') || permissions.has('postbacks.manage');

export interface TrackingSnippets {
  server_postback: string | null;
  image_pixel: string | null;
  iframe_pixel: string | null;
  js_tag: string | null;
}

export const buildTrackingSnippets = (base: string | null, token: string | null, event = 'sale', currency = 'USD'): TrackingSnippets => {
  if (!base) return { server_postback: null, image_pixel: null, iframe_pixel: null, js_tag: null };
  const pixelUrl = `${base}/pixel?click_id={click_id}&event=${event}&txn_id={order_id}&amount={order_total}&currency=${currency}`;
  return {
    server_postback: token ? `${base}/postback?click_id={click_id}&token=${token}&event=${event}&txn_id={order_id}&amount={order_total}&currency=${currency}` : null,
    image_pixel: `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:none" referrerpolicy="no-referrer">`,
    iframe_pixel: `<iframe src="${pixelUrl}" width="1" height="1" frameborder="0" scrolling="no" style="display:none" referrerpolicy="no-referrer"></iframe>`,
    js_tag: `<script src="${base}/ntrack.js" async></script>\n<script>\n  // On the thank-you page, after the script loads:\n  window.ntrack && window.ntrack.convert({ event: '${event}', txn_id: 'ORDER_ID', amount: '49.90', currency: '${currency}' });\n</script>`,
  };
};

export const TRACKING_METHOD_NOTES: Record<ConversionTrackingMethod, string> = {
  server_postback: 'Your server calls this URL when an order completes. Most reliable: works without cookies or browser scripts. Keep the token secret.',
  image_pixel: 'Place on the order confirmation page. Replace {click_id} with the click ID you saved from the landing page URL. Without click_id the pixel only works when the click cookie is turned on (Settings, Tracking, Click cookie days), like a Trackier pixel, and some browsers block that cookie.',
  iframe_pixel: 'Same as the image pixel, for platforms that only accept iframes. Replace {click_id} with the saved click ID.',
  js_tag: 'Add to the landing and confirmation pages. The script remembers the click ID from the landing page URL and sends the conversion when convert() is called.',
};

export const TRACKING_SETUP_NOTES = [
  'Pass the NTrack click ID to the advertiser: add {click_id} to the landing page URL (e.g. ?aff_click={click_id}) and store it with the order.',
  'Send a unique txn_id per order so retries and duplicate conversions are ignored.',
];
