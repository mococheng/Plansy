// End-to-end over real sockets: create, join, plan, react, re-plan, lock, late join, stats.
// OFFLINE=1 skips weather and the AI call, so plans come from the rule-based fallback.
const os = require('os');
const path = require('path');
process.env.OFFLINE = '1';
process.env.EVENT_LOG = path.join(os.tmpdir(), `plansy-test-${process.pid}.jsonl`);
const test = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const { server, rooms, funnel } = require('../server');
const { hoods } = require('../data/places');

const emit = (s, ev, data) => new Promise((res) => s.emit(ev, data, res));
const once = (s, ev) => new Promise((res) => s.once(ev, res));
const inHours = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const profile = (id, extra = {}) => ({
  id, name: id, budget: 3, maxWalkMin: 20, canTravel: true, minTempF: 40, okRain: true, diet: [],
  location: hoods['East Village'], hood: 'East Village', timePref: { mode: 'arrive', at: inHours(3) }, ...extra,
});
let url;
test.before(() => new Promise((r) => server.listen(0, () => { url = `http://localhost:${server.address().port}`; r(); })));
test.after(() => new Promise((r) => server.close(r)));

async function makeRoom(host, opts = {}) {
  return new Promise((res) => host.emit('create', {
    profile: profile('Ana'), archetypes: ['dinner', 'drinks'], tzOffset: 0,
    weatherOverride: { tempF: 60, raining: false, source: 'test' }, ...opts,
  }, res));
}
const waitLobby = (s, pred) => new Promise((res) => { const h = (st) => { if (pred(st)) { s.off('lobby', h); res(st); } }; s.on('lobby', h); });

test('three people: plan, object, re-plan, lock in, everyone gets a plan', async () => {
  const [a, b, c] = [connect(url), connect(url), connect(url)];
  try {
    const { code } = await makeRoom(a);
    const joined = await emit(b, 'join', { code, profile: profile('Ben', { budget: 2 }), via: 'link' });
    assert.equal(joined.hostName, 'Ana');
    assert.ok((await emit(c, 'join', { code, profile: profile('Cam', { diet: ['vegetarian'] }) })).ok);
    assert.equal((await emit(c, 'join', { code: 'ZZZZ', profile: profile('X') })).error, 'expired');

    assert.equal((await emit(b, 'plan', {})).ok, false, 'only the organizer plans');
    const props = Promise.all([a, b, c].map((s) => once(s, 'proposal')));
    assert.ok((await emit(a, 'plan', {})).ok);
    const [p] = await props;
    assert.equal(p.source, 'rules');
    assert.ok(p.pick.place && p.pick.why);
    assert.ok(p.backups.length >= 1 && p.backups.length <= 2);
    for (const opt of [p.pick, ...p.backups]) {
      assert.ok(opt.place.price <= 2, 'lowest budget');
      assert.ok(opt.place.archetypes.some((x) => ['dinner', 'drinks'].includes(x)));
      assert.equal(opt.place.people.length, 3);
    }

    // Ben objects, Cam is in; the organizer sees both.
    const seen = waitLobby(a, (s) => s.members.filter((m) => m.reaction).length === 2);
    b.emit('react', { ok: false, reason: 'Too far' });
    c.emit('react', { ok: true });
    const s = await seen;
    assert.equal(s.members.find((m) => m.id === 'Ben').reaction.reason, 'Too far');

    // Re-plan clears reactions and bumps the round.
    const again = once(a, 'proposal');
    assert.ok((await emit(a, 'plan', {})).ok);
    const p2 = await again;
    assert.equal(p2.round, p.round + 1);
    assert.notEqual(p2.pick.id, p.pick.id, 'moves off the place Ben objected to');
    assert.deepEqual(rooms.get(code).reactions, {});

    // Lock in a backup: everyone gets the locked place and their own plan.
    const choice = p2.backups[0].id;
    const locked = Promise.all([a, b, c].map((s) => once(s, 'locked')));
    const plans = Promise.all([a, b, c].map((s) => once(s, 'plan')));
    assert.equal((await emit(b, 'choose', { id: choice })).ok, false, 'only the organizer locks');
    assert.equal((await emit(a, 'choose', { id: 'nope' })).ok, false, 'only offered options');
    assert.ok((await emit(a, 'choose', { id: choice })).ok);
    const [l] = await locked;
    assert.equal(l.place.id, choice);
    const [pa] = await plans;
    assert.equal(pa.meetAt, l.meetAt);
    assert.ok(Date.parse(pa.leaveBy) <= Date.parse(pa.meetAt));
  } finally { [a, b, c].forEach((s) => s.close()); }
});

test('timing shapes the plan: a "leave at" time is never earlier than the person said', async () => {
  const [a, b] = [connect(url), connect(url)];
  try {
    const { code } = await makeRoom(a);
    const departAt = inHours(2);
    await emit(b, 'join', { code, profile: profile('Ben', { location: hoods.Midtown, hood: 'Midtown', timePref: { mode: 'depart', at: departAt } }) });
    const prop = once(a, 'proposal'); await emit(a, 'plan', {}); const p = await prop;
    for (const opt of [p.pick, ...p.backups]) {
      const ben = opt.place.people.find((x) => x.id === 'Ben');
      assert.equal(ben.mode, 'depart');
      assert.ok(Date.parse(ben.leaveBy) >= Date.parse(departAt) - 1000);
    }
    // Changing your time shows in the lobby.
    const later = inHours(4);
    const seen = waitLobby(a, (s) => (s.members.find((m) => m.id === 'Ben').timePref || {}).at === later);
    assert.ok((await emit(b, 'time', { timePref: { mode: 'arrive', at: later } })).ok);
    await seen;
  } finally { [a, b].forEach((s) => s.close()); }
});

test('a solo host can drop and the invite still works', async () => {
  const a = connect(url);
  const { code } = await makeRoom(a);
  a.close();
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(rooms.has(code), 'room survives host disconnect');
  const res = await (await fetch(`${url}/api/room/${code}`)).json();
  assert.equal(res.hostName, 'Ana');
  const b = connect(url);
  try { assert.ok((await emit(b, 'join', { code, profile: profile('Ben') })).ok); } finally { b.close(); }
});

test('late joiners see the current proposal, and the locked plan after', async () => {
  const [a, b] = [connect(url), connect(url)];
  const extra = [];
  try {
    const { code } = await makeRoom(a);
    await emit(b, 'join', { code, profile: profile('Ben') });
    const prop = once(a, 'proposal'); await emit(a, 'plan', {}); const p = await prop;
    const late = connect(url); extra.push(late);
    const lp = once(late, 'proposal');
    assert.ok((await emit(late, 'join', { code, profile: profile('Cy') })).ok);
    assert.equal((await lp).pick.id, p.pick.id);
    await emit(a, 'choose', { id: p.pick.id });
    const later = connect(url); extra.push(later);
    const got = Promise.all([once(later, 'locked'), once(later, 'plan')]);
    await emit(later, 'join', { code, profile: profile('Dee') });
    const [l, plan] = await got;
    assert.equal(l.place.id, p.pick.id);
    assert.equal(plan.memberId, 'Dee');
  } finally { [a, b, ...extra].forEach((s) => s.close()); }
});

test('when nothing fits, the organizer can loosen the limit that cut the most', async () => {
  const [a, b] = [connect(url), connect(url)];
  try {
    const strict = { canTravel: false, maxWalkMin: 5, budget: 1, diet: ['kosher'] };
    const { code } = await makeRoom(a, { profile: profile('Ana', strict), archetypes: ['active'] });
    await emit(b, 'join', { code, profile: profile('Ben', strict) });
    const prop = once(a, 'proposal'); await emit(a, 'plan', {}); const p = await prop;
    assert.ok(p.none);
    assert.ok(p.blocker && p.blocker.action);
    const next = once(a, 'proposal');
    assert.ok((await emit(a, 'loosen', { what: p.blocker.what })).ok);
    assert.ok(await next);
  } finally { [a, b].forEach((s) => s.close()); }
});

test('changing your starting point updates the lobby and your leave-by', async () => {
  const [a, b] = [connect(url), connect(url)];
  try {
    const { code } = await makeRoom(a);
    await emit(b, 'join', { code, profile: profile('Ben', { canTravel: false, maxWalkMin: 60 }) });
    const moved = waitLobby(a, (s) => (s.members.find((x) => x.id === 'Ben') || {}).from === 'Midtown');
    assert.ok((await emit(b, 'location', { location: hoods.Midtown, hood: 'Midtown' })).ok);
    await moved;
    assert.equal((await emit(b, 'location', { location: { lat: 'x', lng: 999 }, hood: 'Nowhere' })).ok, false, 'junk rejected');

    const prop = once(a, 'proposal'); await emit(a, 'plan', {}); const p = await prop;
    const first = once(b, 'plan');
    await emit(a, 'choose', { id: p.pick.id });
    const before = await first;
    assert.equal(before.from, 'Midtown');
    const after = once(b, 'plan');
    await emit(b, 'location', { location: hoods.Williamsburg, hood: 'Williamsburg' });
    const now = await after;
    assert.equal(now.from, 'Williamsburg');
    assert.notEqual(now.leaveBy, before.leaveBy, 'new start, new leave-by');
  } finally { [a, b].forEach((s) => s.close()); }
});

test('on a lock, people can share status with the group', async () => {
  const [a, b] = [connect(url), connect(url)];
  try {
    const { code } = await makeRoom(a);
    await emit(b, 'join', { code, profile: profile('Ben') });
    const prop = once(a, 'proposal'); await emit(a, 'plan', {}); const p = await prop;
    await emit(a, 'choose', { id: p.pick.id });
    const lobby = waitLobby(a, (s) => s.members.some((m) => m.status));
    b.emit('status', { state: 'late' });
    const s = await lobby;
    assert.equal(s.members.find((m) => m.id === 'Ben').status.label, 'Running 10 min late');
  } finally { [a, b].forEach((s) => s.close()); }
});

test('public-internet limits: full groups and junk timing', async () => {
  const host = connect(url);
  const extra = [];
  try {
    const { code } = await makeRoom(host);
    for (let i = 0; i < 11; i++) {
      const s = connect(url); extra.push(s);
      assert.ok((await emit(s, 'join', { code, profile: profile(`P${i}`) })).ok);
    }
    const late = connect(url); extra.push(late);
    assert.equal((await emit(late, 'join', { code, profile: profile('Thirteen') })).error, 'full');
    const junk = connect(url); extra.push(junk);
    await emit(junk, 'create', { profile: profile('Junk', { timePref: { mode: 'whenever', at: 'x' } }), archetypes: ['nope'] });
    const r = [...rooms.values()].find((x) => x.members.has('Junk'));
    assert.equal(r.members.get('Junk').timePref, null);
    assert.deepEqual(r.archetypes, ['catchup', 'dinner', 'drinks'], 'unknown archetypes fall back to defaults');
  } finally { [host, ...extra].forEach((s) => s.close()); }
});

test('stats funnel counts decided groups', () => {
  const f = funnel();
  assert.ok(f.funnel.created >= 4);
  assert.ok(f.funnel.planned >= 3);
  assert.ok(f.weeklyDecidedGroups >= 1);
  assert.ok(f.joinsByLink >= 1);
});
