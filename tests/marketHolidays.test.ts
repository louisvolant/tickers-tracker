import { test, describe } from 'node:test';
import assert from 'node:assert';
import marketHolidaysData from '../src/lib/marketHolidays.json';
import { MARKET_CALENDARS } from '../src/lib/marketCalendar.ts';
import {
  holidayTableAgeDays,
  holidayTableNeedsRefresh,
  type MarketHolidaysFile,
} from '../src/lib/marketHolidays.ts';
import { normalizeHolidayName } from '../scripts/generate-market-holidays.ts';

const table = marketHolidaysData as MarketHolidaysFile;

describe('Generated market holiday table', () => {
  test('is parseable and covers at least next year', () => {
    assert.ok(!Number.isNaN(Date.parse(table.generatedAt)), 'generatedAt must be an ISO date');

    const currentYear = new Date().getUTCFullYear();
    assert.ok(
      table.coverage.to >= currentYear + 1,
      `table ends in ${table.coverage.to}, must reach ${currentYear + 1}`
    );
    assert.ok(table.coverage.from <= currentYear);
  });

  test('has a sorted, de-duplicated entry for every configured venue', () => {
    for (const timezone of Object.keys(MARKET_CALENDARS)) {
      const dates = table.holidays[timezone];
      assert.ok(Array.isArray(dates), `missing holidays for ${timezone}`);
      assert.ok(dates.length > 0, `empty holidays for ${timezone}`);

      assert.deepStrictEqual(dates, [...dates].sort(), `${timezone} must be sorted`);
      assert.strictEqual(new Set(dates).size, dates.length, `${timezone} must not contain duplicates`);

      for (const date of dates) {
        assert.match(date, /^\d{4}-\d{2}-\d{2}$/, `${timezone} has a malformed date: ${date}`);
      }
    }
  });

  test('keeps the closures the exchange calendars rely on', () => {
    // Fixed-date holidays.
    assert.ok(table.holidays['Europe/Paris'].includes('2026-12-25'));
    assert.ok(table.holidays['America/New_York'].includes('2026-01-01'));

    // Movable closures: Good Friday and Easter Monday 2026.
    assert.ok(table.holidays['Europe/Paris'].includes('2026-04-03'), 'Good Friday');
    assert.ok(table.holidays['Europe/Paris'].includes('2026-04-06'), 'Easter Monday');

    // Venue-specific closure that is not a country holiday.
    assert.ok(table.holidays['Europe/Paris'].includes('2026-05-01'), 'Labour Day');
  });

  test('omits holidays the venue ignores', () => {
    // Euronext Paris trades on Victory Day and All Saints' Day; Euronext
    // Amsterdam trades on King's Day; NYSE trades on Columbus Day.
    assert.ok(!table.holidays['Europe/Paris'].includes('2026-05-08'));
    assert.ok(!table.holidays['Europe/Paris'].includes('2026-11-01'));
    assert.ok(!table.holidays['Europe/Amsterdam'].includes('2026-04-27'));
    assert.ok(!table.holidays['America/New_York'].includes('2026-10-12'));
  });

  test('normalizes typographic apostrophes in holiday names', () => {
    assert.strictEqual(normalizeHolidayName("All Saints\u2019 Day"), "All Saints' Day");
    assert.strictEqual(normalizeHolidayName("King\u2018s Day"), "King's Day");
    assert.strictEqual(normalizeHolidayName("  All Saints' Day  "), "All Saints' Day");
  });

  test('refresh logic reacts to age, coverage and malformed data', () => {
    const now = Date.UTC(2026, 9, 21);
    const base: MarketHolidaysFile = {
      generatedAt: '2026-10-01',
      coverage: { from: 2026, to: 2040 },
      holidays: {},
    };

    assert.strictEqual(holidayTableNeedsRefresh(base, now, 30), false);

    // Older than the threshold.
    assert.strictEqual(
      holidayTableNeedsRefresh({ ...base, generatedAt: '2026-01-01' }, now, 30),
      true
    );

    // No longer covers next year.
    assert.strictEqual(
      holidayTableNeedsRefresh({ ...base, coverage: { from: 2026, to: 2026 } }, now, 30),
      true
    );

    // Missing/invalid payloads trigger a regeneration.
    assert.strictEqual(holidayTableNeedsRefresh(null, now, 30), true);
    assert.strictEqual(holidayTableAgeDays('not-a-date', now), Infinity);
  });
});
