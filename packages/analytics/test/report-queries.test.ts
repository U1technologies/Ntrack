import { describe, expect, it } from 'vitest';
import { buildClickReportQuery } from '../src/click-reports';
import { buildConversionReportQuery } from '../src/conversion-reports';

const scope = { organizationId: '11111111-1111-4111-8111-111111111111', restricted: false, advertiserIds: [], publisherIds: [] };
const range = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z', timezone: 'UTC' };

describe('report query builders', () => {
  it('always constrains click reports to the organization and binds user values as parameters', () => {
    const { query, params } = buildClickReportQuery({ scope, ...range, dimensions: ['country'], metrics: ['clicks'], filters: { sub1: ["x' OR 1=1 --"] } });
    expect(query).toContain('organization_id = {org:UUID}');
    expect(query).not.toContain("x' OR 1=1");
    expect(Object.values(params)).toContainEqual(["x' OR 1=1 --"]);
  });

  it('drops unknown dimensions instead of interpolating them', () => {
    const { query } = buildClickReportQuery({ scope, ...range, dimensions: ['country; DROP TABLE clicks' as never], metrics: ['clicks'] });
    expect(query).not.toContain('DROP');
  });

  it('matches nothing for a restricted user with no assignments', () => {
    const { query } = buildClickReportQuery({ scope: { ...scope, restricted: true }, ...range, dimensions: [], metrics: ['clicks'] });
    expect(query).toMatch(/ AND 0/);
  });

  it('scopes conversion reports to the publisher and reads the latest versions', () => {
    const built = buildConversionReportQuery({ scope: { ...scope, restricted: true, publisherIds: ['p1'] }, ...range, dimensions: ['date'] });
    expect(built?.query).toContain('FROM conversions AS c FINAL');
    expect(built?.query).toContain('c.publisher_id IN {scopePub:Array(UUID)}');
  });

  it('returns null for dimensions conversions do not have', () => {
    expect(buildConversionReportQuery({ scope, ...range, dimensions: ['browser'] })).toBeNull();
  });
});
