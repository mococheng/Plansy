const test = require('node:test');
const assert = require('node:assert');
const P = require('../lib/planner');
const A = require('../lib/archetypes');
const AI = require('../lib/ai');
const { places, hoods } = require('../data/places');

// Fixed "now": 5pm UTC, and the group is on UTC so opening hours read simply.
const now = new Date('2026-11-05T17:00:00Z');
const at = (hhmm) => `2026-11-05T${hhmm}:00.000Z`;
const person = (id, extra = {}) => ({
  id, name: id, budget: 4, maxWalkMin: 30, canTravel: true, minTempF: 0, okRain: true, diet: [],
  location: hoods['East Village'], hood: 'East Village', timePref: null, ...extra,
});
const plan = (members, opts = {}) => P.candidates(places, members, { now, tzOffset: 0, weather: { tempF: 60, raining: false }, ...opts });

test('everyone arriving at the same time meets at that time', () => {
  const { list } = plan([person('Ana', { timePref: { mode: 'arrive', at: at('19:00') } }), person('Ben', { timePref: { mode: 'arrive', at: at('19:00') } })]);
  assert.ok(list.length >= 3);
  for (const c of list) {
    assert.equal(c.meetAt, at('19:00'));
    assert.deepEqual(c.issues, []);
  }
});

test('a "leave at" time pushes the meet late enough for that person to get there', () => {
  const ben = person('Ben', { location: hoods.Williamsburg, hood: 'Williamsburg', timePref: { mode: 'depart', at: at('18:30') } });
  const { list } = plan([person('Ana', { timePref: { mode: 'arrive', at: at('18:30') } }), ben]);
  for (const c of list) {
    const b = c.people.find((p) => p.id === 'Ben');
    assert.ok(Date.parse(b.leaveBy) >= Date.parse(at('18:30')), 'Ben never has to leave before he said');
    assert.ok(Date.parse(c.meetAt) >= Date.parse(at('18:30')) + b.travelMin * 60e3, 'meet allows for his trip');
  }
});

test('arrive times far apart are flagged, not hidden', () => {
  const { list } = plan([person('Ana', { timePref: { mode: 'arrive', at: at('18:00') } }), person('Cam', { timePref: { mode: 'arrive', at: at('20:00') } })]);
  assert.ok(list[0].issues.some((t) => t.includes('Cam') && t.includes('earlier')));
});

test('only places that fit the chosen archetypes are offered', () => {
  const { list } = plan([person('Ana')], { archetypes: ['active'] });
  assert.ok(list.length > 0);
  assert.ok(list.every((c) => c.archetypes.includes('active') && A.byId.active.fits(c)));
  const home = plan([person('Ana')], { archetypes: ['nightin'] }).list;
  assert.ok(home.every((c) => c.category === 'watch' && c.people[0].how === 'home'));
});

test('opening hours are checked at the actual meet time', () => {
  const { list } = plan([person('Ana', { timePref: { mode: 'arrive', at: at('09:00') } })], { archetypes: ['drinks', 'bignight'] });
  // Bars open in the evening, so a 9am meet leaves few or none and never a closed one.
  assert.ok(list.every((c) => { const p = places.find((x) => x.id === c.id); return !p.hours || p.hours.open <= 9; }));
});

test('rule-based pick gives one plan and two different backups', () => {
  const { list } = plan([person('Ana'), person('Ben')], { archetypes: ['dinner', 'drinks', 'active'] });
  const r = P.rulePick(list);
  assert.equal(r.source, 'rules');
  assert.equal(r.pick.id, list[0].id);
  assert.equal(r.backups.length, 2);
  assert.ok(!r.backups.some((b) => b.id === r.pick.id));
  assert.ok(r.pick.why.length > 10);
});

test('streaming only counts as a night in, never a night out', () => {
  const { list } = plan([person('Ana')], { archetypes: ['bignight', 'culture', 'catchup'] });
  assert.ok(list.length && list.every((c) => c.category !== 'watch'));
});

test('after an objection, the rule-based pick moves off the place people objected to', () => {
  const { list } = plan([person('Ana'), person('Ben')], { archetypes: ['dinner', 'drinks'] });
  const first = P.rulePick(list), second = P.rulePick(list, [first.pick.id]);
  assert.notEqual(second.pick.id, first.pick.id);
  assert.ok(second.backups.every((b) => b.id !== first.pick.id) || list.length <= 3);
});

test('time preferences are validated', () => {
  assert.equal(P.cleanTimePref({ mode: 'later', at: at('19:00') }, now), null);
  assert.equal(P.cleanTimePref({ mode: 'arrive', at: 'soon' }, now), null);
  assert.equal(P.cleanTimePref({ mode: 'arrive', at: '2030-01-01T00:00:00Z' }, now), null);
  assert.deepEqual(P.cleanTimePref({ mode: 'depart', at: at('19:00') }, now), { mode: 'depart', at: at('19:00') });
});

test('the AI briefing uses local clock times and only offered ids', () => {
  const members = [person('Ana', { timePref: { mode: 'arrive', at: at('19:00') } })];
  const built = plan(members);
  const b = AI.briefing({ members, archetypes: built.archetypes, list: built.list, group: built.group, weather: { tempF: 60 }, tzOffset: 300 });
  assert.equal(b.people[0].timing, 'wants to arrive at 2:00 pm'); // 19:00 UTC in UTC-5
  assert.deepEqual(b.options.map((o) => o.id), built.list.map((c) => c.id));
  const schema = AI.schemaFor(built.list.map((c) => c.id));
  assert.deepEqual(schema.properties.pick.properties.id.enum, built.list.map((c) => c.id));
});

test('without an API key the AI step steps aside', async () => {
  const saved = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  try { assert.equal(await AI.aiPick({ list: [{ id: 'x' }] }), null); }
  finally { if (saved) process.env.ANTHROPIC_API_KEY = saved; }
});
