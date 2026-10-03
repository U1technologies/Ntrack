import { describe, expect, it } from 'vitest';
import { advertiserWhere, campaignWhere, trackingLinkWhere } from '../src/services/access-scope';
import type { AccessScope } from '../src/types';

const org: AccessScope = { type: 'organization', restricted: false, advertiserIds: [], publisherIds: [] };
const publisher: AccessScope = { type: 'publisher', restricted: true, advertiserIds: [], publisherIds: ['p1'] };
const orphan: AccessScope = { type: 'managed', restricted: true, advertiserIds: [], publisherIds: [] };

describe('access scope filters', () => {
  it('adds no filter for organization-wide roles', () => {
    expect(campaignWhere(org)).toEqual({});
    expect(advertiserWhere(org)).toEqual({});
  });

  it('limits publishers to campaigns they are approved on', () => {
    expect(campaignWhere(publisher)).toEqual({ AND: [{ OR: [{ publishers: { some: { publisherId: { in: ['p1'] }, status: 'approved' } } }] }] });
    expect(trackingLinkWhere(publisher)).toEqual({ AND: [{ OR: [{ publisherId: { in: ['p1'] } }] }] });
  });

  it('matches nothing for a restricted user without assignments', () => {
    expect(campaignWhere(orphan)).toEqual({ AND: [{ id: { in: [] } }] });
    expect(advertiserWhere(orphan)).toEqual({ AND: [{ id: { in: [] } }] });
  });

  it('survives being spread next to an id lookup and a search OR (regression: filters overwrote each other)', () => {
    const where = { id: 'p-other', OR: [{ name: 'x' }], ...trackingLinkWhere(publisher) };
    expect(where.id).toBe('p-other');
    expect(where.OR).toEqual([{ name: 'x' }]);
    expect(where.AND).toBeDefined();
  });
});
