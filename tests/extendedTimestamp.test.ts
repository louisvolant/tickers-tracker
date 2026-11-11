import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatExtendedTimestamp } from '../src/lib/utils';

// Friday 2026-11-06 21:00 UTC: the after-hours tick that used to survive the weekend.
const FRIDAY_POST = Date.UTC(2026, 10, 6, 21, 0);

describe('Extended-session badge timestamp', () => {
  test('formats the tick with its weekday and local time', () => {
    const text = formatExtendedTimestamp(FRIDAY_POST, 'en-GB');
    assert.match(text, /^Fri/);
    assert.match(text, /\b\d{2}:\d{2}\b/);
  });

  test('localises the weekday', () => {
    assert.match(formatExtendedTimestamp(FRIDAY_POST, 'fr-FR'), /^ven\./i);
  });

  test('returns an empty string when the tick has no timestamp', () => {
    assert.equal(formatExtendedTimestamp(null, 'en-GB'), '');
    assert.equal(formatExtendedTimestamp(undefined, 'en-GB'), '');
    assert.equal(formatExtendedTimestamp(Number.NaN, 'en-GB'), '');
  });
});
