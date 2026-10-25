import { describe, it, expect } from 'vitest';
import { holidaysForYear, holidayOn, holidaysBetween, seasonFor } from '../src/holidays.js';

describe('holidays', () => {
  it('computes the moving ones correctly for 2026', () => {
    const h = Object.fromEntries(holidaysForYear(2026).map((x) => [x.name, x.date]));
    expect(h['Thanksgiving']).toBe('2026-11-26');
    expect(h['Small Business Saturday']).toBe('2026-11-28');
    expect(h['Memorial Day']).toBe('2026-05-25');
    expect(h['Labor Day']).toBe('2026-09-07');
    expect(h['Martin Luther King Jr. Day']).toBe('2026-01-19');
    expect(h['Easter']).toBe('2026-04-05');
    expect(h['Halloween']).toBe('2026-10-31');
  });
  it('finds holidays in a week and the season before one', () => {
    expect(holidaysBetween('2026-10-26', '2026-11-01').map((x) => x.name)).toEqual(['Halloween']);
    expect(holidayOn('2026-12-25')?.theme).toBe('christmas');
    expect(seasonFor('2026-12-18')).toBe('christmas');
    expect(seasonFor('2026-08-12')).toBeNull();
    expect(holidaysBetween('2026-12-28', '2027-01-03').map((x) => x.name)).toEqual(["New Year's Eve", "New Year's Day"]);
  });
});
