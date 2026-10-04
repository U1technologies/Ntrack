/**
 * Documented macro parser for destination URLs and postback/webhook templates.
 *
 * Syntax: `{macro_name}` where the name is one of the registered macros below. `{{` and `}}`
 * produce literal braces. Templates are parsed into segments once, unknown macros are reported
 * as errors at save time, and rendering URL-encodes values for the context (query vs raw), so a
 * value can never inject extra parameters or change the URL structure.
 */

export type MacroContext = 'destination' | 'postback';

export interface MacroDefinition {
  name: string;
  description: string;
  example: string;
  contexts: MacroContext[];
}

const both: MacroContext[] = ['destination', 'postback'];

export const MACROS: MacroDefinition[] = [
  { name: 'click_id', description: 'Unique NTrack click identifier', example: '01J9Z3QK4T8W2M6N7P5R0S1V2X', contexts: both },
  { name: 'campaign_id', description: 'Campaign public ID', example: 'cmp_8fK2LmQ1', contexts: both },
  { name: 'publisher_id', description: 'Publisher public ID', example: 'pub_3TqX9aZ4', contexts: both },
  { name: 'advertiser_id', description: 'Advertiser public ID', example: 'adv_7HsN2wP0', contexts: both },
  { name: 'subid1', description: 'Publisher sub ID 1', example: 'google', contexts: both },
  { name: 'subid2', description: 'Publisher sub ID 2', example: 'campaign01', contexts: both },
  { name: 'subid3', description: 'Publisher sub ID 3', example: 'adgroup7', contexts: both },
  { name: 'subid4', description: 'Publisher sub ID 4', example: 'creative12', contexts: both },
  { name: 'subid5', description: 'Publisher sub ID 5', example: 'placement3', contexts: both },
  { name: 'source', description: 'Traffic source declared on the click', example: 'search', contexts: both },
  { name: 'country', description: 'ISO country code of the click', example: 'US', contexts: both },
  { name: 'device', description: 'Device type of the click', example: 'mobile', contexts: both },
  { name: 'timestamp', description: 'Unix timestamp (seconds) of the event', example: '1759449600', contexts: both },
  { name: 'gaid', description: 'Google Advertising ID of an Android device, passed in on the click (?gaid=)', example: '38400000-8cf0-11bd-b23e-10b96e40000d', contexts: both },
  { name: 'idfa', description: 'Apple ID for Advertisers of an iOS device, passed in on the click (?idfa=)', example: '6D92078A-8246-4BA4-AE5B-76104861E7DC', contexts: both },
  { name: 'app_name', description: 'Name or bundle ID of the app that sent the click (?app_name=)', example: 'com.example.travel', contexts: both },
  { name: 'external_click_id', description: 'Click ID passed in by the traffic source (e.g. gclid)', example: 'EAIaIQobChMI', contexts: both },
  { name: 'conversion_id', description: 'NTrack conversion identifier', example: 'cnv_5d2F9kLm', contexts: ['postback'] },
  { name: 'transaction_id', description: 'Advertiser transaction/order ID', example: 'ORD-10442', contexts: ['postback'] },
  { name: 'event', description: 'Conversion event type', example: 'sale', contexts: ['postback'] },
  { name: 'status', description: 'Conversion status', example: 'approved', contexts: ['postback'] },
  { name: 'revenue', description: 'Advertiser revenue for the conversion', example: '25.00', contexts: ['postback'] },
  { name: 'payout', description: 'Publisher payout for the conversion', example: '18.50', contexts: ['postback'] },
  { name: 'currency', description: 'ISO currency code', example: 'USD', contexts: ['postback'] },
];

const MACRO_INDEX = new Map(MACROS.map((m) => [m.name, m]));

export type TemplateSegment = { type: 'text'; value: string } | { type: 'macro'; name: string };

export interface ParsedTemplate {
  segments: TemplateSegment[];
  macros: string[];
  errors: string[];
}

const NAME_PATTERN = /^[a-z][a-z0-9_]{0,40}$/;

export const parseTemplate = (template: string, context: MacroContext): ParsedTemplate => {
  const segments: TemplateSegment[] = [];
  const macros = new Set<string>();
  const errors: string[] = [];
  let text = '';
  let i = 0;

  const flushText = () => {
    if (text) segments.push({ type: 'text', value: text });
    text = '';
  };

  while (i < template.length) {
    const char = template[i];
    if (char === '{' && template[i + 1] === '{') {
      text += '{';
      i += 2;
      continue;
    }
    if (char === '}' && template[i + 1] === '}') {
      text += '}';
      i += 2;
      continue;
    }
    if (char === '{') {
      const end = template.indexOf('}', i + 1);
      if (end === -1) {
        errors.push(`Unclosed macro starting at position ${i}.`);
        text += template.slice(i);
        break;
      }
      const name = template.slice(i + 1, end).trim();
      const definition = MACRO_INDEX.get(name);
      if (!NAME_PATTERN.test(name) || !definition) {
        errors.push(`Unknown macro {${name}}.`);
      } else if (!definition.contexts.includes(context)) {
        errors.push(`Macro {${name}} is not available in ${context} templates.`);
      } else {
        flushText();
        segments.push({ type: 'macro', name });
        macros.add(name);
      }
      i = end + 1;
      continue;
    }
    if (char === '}') {
      errors.push(`Unmatched "}" at position ${i}.`);
    }
    text += char;
    i += 1;
  }
  flushText();
  return { segments, macros: [...macros], errors };
};

export type MacroValues = Partial<Record<string, string | number | null | undefined>>;
export type MacroEncoding = 'query' | 'raw';

export const renderSegments = (segments: TemplateSegment[], values: MacroValues, encoding: MacroEncoding): string =>
  segments
    .map((segment) => {
      if (segment.type === 'text') return segment.value;
      const value = values[segment.name];
      const str = value === null || value === undefined ? '' : String(value);
      return encoding === 'query' ? encodeURIComponent(str) : str;
    })
    .join('');

/** Parses and renders in one step. Throws if the template contains errors. */
export const renderTemplate = (
  template: string,
  values: MacroValues,
  { context, encoding }: { context: MacroContext; encoding: MacroEncoding }
): string => {
  const parsed = parseTemplate(template, context);
  if (parsed.errors.length > 0) throw new Error(`Invalid template: ${parsed.errors.join(' ')}`);
  return renderSegments(parsed.segments, values, encoding);
};

/** Renders macros inside every string value of a JSON body template (keys are left as is). */
export const renderJsonTemplate = (template: unknown, values: MacroValues): unknown => {
  if (typeof template === 'string') return renderTemplate(template, values, { context: 'postback', encoding: 'raw' });
  if (Array.isArray(template)) return template.map((item) => renderJsonTemplate(item, values));
  if (template && typeof template === 'object') {
    return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, renderJsonTemplate(value, values)]));
  }
  return template;
};

/** Collects parse errors from every string inside a JSON body template. */
export const validateJsonTemplate = (template: unknown): string[] => {
  if (typeof template === 'string') return parseTemplate(template, 'postback').errors;
  if (Array.isArray(template)) return template.flatMap(validateJsonTemplate);
  if (template && typeof template === 'object') return Object.values(template).flatMap(validateJsonTemplate);
  return [];
};
