const test = require('node:test');
const assert = require('node:assert');
const T = require('../lib/timing');
const { hoods } = require('../data/places');

const ev = hoods['East Village'];
const place = { lat: ev.lat + 0.004, lng: ev.lng, name: 'Spot' };
const far = { lat: hoods.Midtown.lat, lng: hoods.Midtown.lng };

test('walkers walk; subway riders take transit only when it is faster', () => {
  assert.equal(T.travelFor(ev, place, true).mode, 'walk', 'short trips are walked even if subway is OK');
  const walker = T.travelFor(ev, far, false);
  const rider = T.travelFor(ev, far, true);
  assert.equal(walker.mode, 'walk');
  assert.equal(rider.mode, 'transit');
  assert.ok(rider.minutes < walker.minutes);
  assert.equal(T.travelFor(ev, { lat: null }, false).mode, 'home');
});

test('leave-by = meet time minus travel minus buffer, nudge 5 min earlier', () => {
  const meetAt = '2026-10-31T23:00:00.000Z';
  const p = T.personalPlan({ id: 'a', location: ev, canTravel: false, hood: 'East Village' }, place, meetAt,
    new Date('2026-10-31T20:00:00Z'));
  const expectLeave = Date.parse(meetAt) - (p.travelMin + T.BUFFER_MIN) * 60e3;
  assert.equal(Date.parse(p.leaveBy), expectLeave);
  assert.equal(Date.parse(p.nudgeAt), expectLeave - T.NUDGE_BEFORE_MIN * 60e3);
  assert.equal(p.leaveNow, false);
  assert.equal(p.from, 'East Village');
});

test('people farther away get an earlier leave-by', () => {
  const meetAt = '2026-10-31T23:00:00.000Z';
  const near = T.personalPlan({ id: 'a', location: ev, canTravel: true }, place, meetAt);
  const away = T.personalPlan({ id: 'b', location: far, canTravel: true }, place, meetAt);
  assert.ok(Date.parse(away.leaveBy) < Date.parse(near.leaveBy));
});

test('meet time: accepts a sane request, otherwise next quarter hour + 30', () => {
  const now = new Date('2026-10-31T16:52:10Z');
  assert.equal(T.resolveMeetAt('2026-10-31T23:00:00.000Z', now), '2026-10-31T23:00:00.000Z');
  assert.equal(T.resolveMeetAt('garbage', now), '2026-10-31T17:30:00.000Z');
  assert.equal(T.resolveMeetAt('2027-01-01T00:00:00Z', now), '2026-10-31T17:30:00.000Z', 'too far ahead');
});
