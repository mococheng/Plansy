// End-to-end over real sockets: create, join, swipe, match, late join, reconnect, stats.
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
const profile = (id, extra = {}) => ({
  id, name: id, budget: 3, maxWalkMin: 20, canTravel: true, minTempF: 40, okRain: true, diet: [],
  location: hoods['East Village'], ...extra,
});
let url;
test.before(() => new Promise((r) => server.listen(0, () => { url = `http://localhost:${server.address().port}`; r(); })));
test.after(() => new Promise((r) => server.close(r)));

async function makeRoom(host, opts = {}) {
  return new Promise((res) => host.emit('create', {
    profile: profile('Ana'), categories: ['eat', 'drink'], hour: 19,
    weatherOverride: { tempF: 60, raining: false, source: 'test' }, ...opts,
  }, res));
}

test('three people: 2 of 3 yeses make a match, results include tickets', async () => {
  const [a, b, c] = [connect(url), connect(url), connect(url)];
  try {
    const { code } = await makeRoom(a);
    const joined = await emit(b, 'join', { code, profile: profile('Ben', { budget: 2 }), via: 'link' });
    assert.equal(joined.hostName, 'Ana');
    assert.ok((await emit(c, 'join', { code, profile: profile('Cam', { diet: ['vegetarian'] }) })).ok);
    assert.equal((await emit(c, 'join', { code: 'ZZZZ', profile: profile('X') })).error, 'expired');

    const decks = Promise.all([a, b, c].map((s) => once(s, 'deck')));
    const started = await emit(a, 'start', {});
    assert.ok(started.ok && started.count > 0 && started.count <= 12);
    const [deckA] = await decks;
    assert.equal(deckA.group.budget, 2, 'lowest budget');
    assert.deepEqual(deckA.group.diet, ['vegetarian']);
    assert.ok(deckA.deck.every((p) => p.price <= 2 && p.diet.includes('vegetarian')));

    const [first, second] = deckA.deck;
    for (const s of [a, b, c]) s.emit('swipe', { placeId: first.id, liked: false });
    const matches = Promise.all([a, b, c].map((s) => once(s, 'match')));
    a.emit('swipe', { placeId: second.id, liked: true });
    b.emit('swipe', { placeId: second.id, liked: true });
    const [m] = await matches;
    assert.equal(m.place.id, second.id);
    assert.equal(m.yes, 2);

    const results = once(a, 'results');
    c.emit('swipe', { placeId: second.id, liked: false });
    for (const s of [a, b, c]) for (const p of deckA.deck.slice(2)) s.emit('swipe', { placeId: p.id, liked: true });
    const r = await results;
    assert.equal(r.match.id, second.id);
    assert.equal(r.vibes.length, 3);
    assert.match(r.vibes[0].card.text, /^Ana's ticket: /);
  } finally { [a, b, c].forEach((s) => s.close()); }
});

test('swiping right on a card records a yes, not a pass', async () => {
  const [a, b] = [connect(url), connect(url)];
  try {
    const { code } = await makeRoom(a);
    await emit(b, 'join', { code, profile: profile('Ben') });
    const deck = once(a, 'deck'); await emit(a, 'start', {}); const d = await deck;
    a.emit('swipe', { placeId: d.deck[0].id, liked: true });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(rooms.get(code).swipes.Ana[d.deck[0].id], true);
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

test('late joiner gets the deck and resumes where they left off', async () => {
  const [a, b] = [connect(url), connect(url)];
  let late;
  try {
    const { code } = await makeRoom(a);
    await emit(b, 'join', { code, profile: profile('Ben') });
    const deck = once(a, 'deck'); await emit(a, 'start', {}); const d = await deck;
    late = connect(url);
    const lateDeck = once(late, 'deck');
    assert.ok((await emit(late, 'join', { code, profile: profile('Cy') })).ok);
    const ld = await lateDeck;
    assert.equal(ld.deck.length, d.deck.length);
    late.emit('swipe', { placeId: d.deck[0].id, liked: true });
    await new Promise((r) => setTimeout(r, 50));
    const again = connect(url);
    const resumed = once(again, 'deck');
    await emit(again, 'join', { code, profile: profile('Cy') });
    assert.equal((await resumed).swiped[d.deck[0].id], true);
    again.close();
  } finally { [a, b, late].forEach((s) => s && s.close()); }
});

test('host can loosen a dead-end deck', async () => {
  const [a, b] = [connect(url), connect(url)];
  try {
    const strict = { canTravel: false, maxWalkMin: 5, budget: 1, diet: ['kosher'] };
    const { code } = await new Promise((res) => a.emit('create', {
      profile: profile('Ana', strict), categories: ['do'], hour: 19,
      weatherOverride: { tempF: 60, raining: false, source: 'test' } }, res));
    await emit(b, 'join', { code, profile: profile('Ben', strict) });
    const deck = once(a, 'deck'); await emit(a, 'start', {}); const d = await deck;
    assert.equal(d.deck.length, 0);
    assert.ok(d.blocker && d.blocker.action);
    const res = await emit(a, 'loosen', { what: d.blocker.what });
    assert.ok(res.ok);
  } finally { [a, b].forEach((s) => s.close()); }
});

test('on a match, each person gets their own leave-by and can share status', async () => {
  const [a, b] = [connect(url), connect(url)];
  try {
    const meetAt = new Date(Date.now() + 3 * 3600e3).toISOString();
    const { code } = await makeRoom(a, { meetAt });
    await emit(b, 'join', { code, profile: profile('Ben', { location: hoods.Midtown, canTravel: false, maxWalkMin: 60 }) });
    const deck = once(a, 'deck'); await emit(a, 'start', {}); const d = await deck;
    const plans = Promise.all([once(a, 'plan'), once(b, 'plan')]);
    a.emit('swipe', { placeId: d.deck[0].id, liked: true });
    b.emit('swipe', { placeId: d.deck[0].id, liked: true });
    const [pa, pb] = await plans;
    assert.equal(pa.memberId, 'Ana'); assert.equal(pb.memberId, 'Ben');
    assert.equal(pa.meetAt, meetAt);
    assert.ok(Date.parse(pa.leaveBy) < Date.parse(meetAt));
    assert.notEqual(pa.leaveBy, pb.leaveBy, 'different starting points, different leave-by');

    const lobby = new Promise((res) => a.on('lobby', (s) => { if (s.members.some((m) => m.status)) res(s); }));
    b.emit('status', { state: 'late' });
    const s = await lobby;
    assert.equal(s.members.find((m) => m.id === 'Ben').status.label, 'Running 10 min late');
  } finally { [a, b].forEach((s) => s.close()); }
});

test('changing your starting point updates the lobby and your leave-by', async () => {
  const [a, b] = [connect(url), connect(url)];
  try {
    const meetAt = new Date(Date.now() + 3 * 3600e3).toISOString();
    const { code } = await makeRoom(a, { meetAt });
    await emit(b, 'join', { code, profile: profile('Ben', { hood: 'East Village', canTravel: false, maxWalkMin: 60 }) });
    const moved = new Promise((res) => a.on('lobby', (s) => { const m = s.members.find((x) => x.id === 'Ben'); if (m && m.from === 'Midtown') res(m); }));
    assert.ok((await emit(b, 'location', { location: hoods.Midtown, hood: 'Midtown' })).ok);
    await moved;
    assert.equal((await emit(b, 'location', { location: { lat: 'x', lng: 999 }, hood: 'Nowhere' })).ok, false, 'junk rejected');

    const deck = once(a, 'deck'); await emit(a, 'start', {}); const d = await deck;
    const firstPlan = once(b, 'plan');
    a.emit('swipe', { placeId: d.deck[0].id, liked: true });
    b.emit('swipe', { placeId: d.deck[0].id, liked: true });
    const before = await firstPlan;
    assert.equal(before.from, 'Midtown');

    const after = once(b, 'plan');
    await emit(b, 'location', { location: hoods.Williamsburg, hood: 'Williamsburg' });
    const p = await after;
    assert.equal(p.from, 'Williamsburg');
    assert.notEqual(p.leaveBy, before.leaveBy, 'new start, new leave-by');
  } finally { [a, b].forEach((s) => s.close()); }
});

test('public-internet limits: full groups and junk tastes', async () => {
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
    const big = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, 1e9]));
    await emit(junk, 'create', { profile: profile('Junk', { tastes: big }) });
    const r = [...rooms.values()].find((x) => x.members.has('Junk'));
    const t = r.members.get('Junk').tastes;
    assert.ok(Object.keys(t).length <= 60 && Object.values(t).every((v) => v <= 3));
  } finally { [host, ...extra].forEach((s) => s.close()); }
});

test('stats funnel counts decided groups', () => {
  const f = funnel();
  assert.ok(f.funnel.created >= 4);
  assert.ok(f.weeklyDecidedGroups >= 1);
  assert.ok(f.joinsByLink >= 1);
});
