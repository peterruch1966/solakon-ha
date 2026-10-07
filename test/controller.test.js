import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeScheduleEntry, zeroFeedInTarget } from '../src/controller.js';

const at = (day, hh, mm = 0) => {
  // 2026-10-04 is a Sunday (day 0)
  const d = new Date(2026, 9, 4 + day, hh, mm);
  assert.equal(d.getDay(), day);
  return d;
};

test('schedule: same-day window', () => {
  const s = [{ start: '08:00', end: '12:00', mode: 'constant', watts: 100 }];
  assert.ok(activeScheduleEntry(s, at(1, 9)));
  assert.equal(activeScheduleEntry(s, at(1, 12)), null);
  assert.equal(activeScheduleEntry(s, at(1, 7, 59)), null);
});

test('schedule: overnight window belongs to the start day', () => {
  const s = [{ start: '22:00', end: '06:00', days: [5], mode: 'constant', watts: 100 }]; // Friday night
  assert.ok(activeScheduleEntry(s, at(5, 23)));
  assert.ok(activeScheduleEntry(s, at(6, 5))); // Saturday early morning
  assert.equal(activeScheduleEntry(s, at(6, 23)), null);
  assert.equal(activeScheduleEntry(s, at(5, 5)), null);
});

test('schedule: disabled entries are skipped, first match wins', () => {
  const s = [
    { enabled: false, start: '00:00', end: '23:59', mode: 'off' },
    { start: '00:00', end: '23:59', mode: 'zero' },
    { start: '00:00', end: '23:59', mode: 'constant' },
  ];
  assert.equal(activeScheduleEntry(s, at(2, 10)).mode, 'zero');
});

const cfg = { targetGridW: 10, smoothing: 1 };

test('zero feed-in raises output when importing', () => {
  assert.equal(zeroFeedInTarget({ gridW: 210, outputW: 100, lastTargetW: 100, cfg, maxW: 800 }), 300);
});

test('zero feed-in lowers output when exporting and never goes negative', () => {
  assert.equal(zeroFeedInTarget({ gridW: -90, outputW: 300, lastTargetW: 300, cfg, maxW: 800 }), 200);
  assert.equal(zeroFeedInTarget({ gridW: -900, outputW: 300, lastTargetW: 300, cfg, maxW: 800 }), 0);
});

test('zero feed-in is capped at max output', () => {
  assert.equal(zeroFeedInTarget({ gridW: 2000, outputW: 600, lastTargetW: 600, cfg, maxW: 800 }), 800);
});

test('zero feed-in applies smoothing and falls back to last target', () => {
  assert.equal(zeroFeedInTarget({ gridW: 110, outputW: null, lastTargetW: 200, cfg: { ...cfg, smoothing: 0.5 }, maxW: 800 }), 250);
});
