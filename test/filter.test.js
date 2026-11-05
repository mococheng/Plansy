const test = require('node:test');
const assert = require('node:assert');
const F = require('../lib/filter');
const { places, hoods } = require('../data/places');

const ev = hoods['East Village'];
const base = { budget: 4, maxWalkMin: 60, canTravel: true, minTempF: 0, okRain: true, diet: [], location: ev };

test('budget uses the lowest in the group', () => {
  const g = F.mergeProfiles([{ ...base, budget: 3 }, { ...base, budget: 1 }]);
  assert.equal(g.budget, 1);
  const { kept } = F.filterPlaces(places, g, { hour: 19 });
  assert.ok(kept.length > 0);
  assert.ok(kept.every((p) => p.price <= 1));
});

test('shortest walk limit wins unless everyone can travel', () => {
  const g = F.mergeProfiles([{ ...base, maxWalkMin: 10, canTravel: false }, { ...base, maxWalkMin: 30 }]);
  assert.equal(g.maxWalkMin, 10);
  assert.equal(g.allTravel, false);
  const { kept } = F.filterPlaces(places, g, { hour: 19, categories: ['eat', 'drink', 'do', 'go'] });
  assert.ok(kept.every((p) => p.walkMin <= 10), 'all within ~10 min walk');
  const g2 = F.mergeProfiles([{ ...base }, { ...base }]);
  assert.ok(F.filterPlaces(places, g2, { hour: 19 }).kept.length > kept.length);
});

test('midpoint is the average of member locations', () => {
  const g = F.mergeProfiles([{ ...base, location: { lat: 40, lng: -74 } }, { ...base, location: { lat: 41, lng: -73 } }]);
  assert.deepEqual(g.center, { lat: 40.5, lng: -73.5 });
});

test('cold or rain removes outdoor places', () => {
  const g = F.mergeProfiles([{ ...base, minTempF: 55, okRain: false }]);
  const cold = F.filterPlaces(places, g, { hour: 14, weather: { tempF: 40, raining: false } });
  assert.equal(cold.outdoorOk, false);
  assert.ok(cold.kept.every((p) => !p.outdoor));
  assert.ok(cold.removed.weather > 0);
  const wet = F.filterPlaces(places, g, { hour: 14, weather: { tempF: 70, raining: true } });
  assert.ok(wet.kept.every((p) => !p.outdoor));
  const nice = F.filterPlaces(places, g, { hour: 14, weather: { tempF: 70, raining: false } });
  assert.ok(nice.kept.some((p) => p.outdoor));
});

test('any member diet restriction applies to the whole group', () => {
  const g = F.mergeProfiles([{ ...base, diet: ['vegan'] }, { ...base, diet: ['gluten-free'] }]);
  assert.deepEqual(g.diet.sort(), ['gluten-free', 'vegan']);
  const { kept } = F.filterPlaces(places, g, { hour: 13, categories: ['eat'] });
  assert.ok(kept.length > 0);
  assert.ok(kept.every((p) => p.diet.includes('vegan') && p.diet.includes('gluten-free')));
});

test('opening hours, including past midnight', () => {
  const late = { hours: { open: 18, close: 27 } };
  assert.ok(F.isOpenAt(late, 23));
  assert.ok(F.isOpenAt(late, 2));
  assert.ok(!F.isOpenAt(late, 4));
  assert.ok(!F.isOpenAt({ hours: { open: 9, close: 16 } }, 19));
});

test('categories make a mixed deck', () => {
  const g = F.mergeProfiles([base]);
  const { kept } = F.filterPlaces(places, g, { hour: 20, categories: ['eat', 'watch'] });
  const cats = new Set(kept.map((p) => p.category));
  assert.deepEqual([...cats].sort(), ['eat', 'watch']);
});

test('tastes move the deck order', () => {
  const g = F.mergeProfiles([base]);
  const { kept } = F.filterPlaces(places, g, { hour: 19, categories: ['eat'] });
  const neutral = F.rankDeck(kept, [base], 5);
  const lover = F.rankDeck(kept, [{ ...base, tastes: { pizza: 3 } }], 5);
  assert.ok(lover.filter((p) => p.subtype === 'pizza').length > neutral.filter((p) => p.subtype === 'pizza').length);
});

test('match requires every member to like the same place', () => {
  const deck = [{ id: 'a' }, { id: 'b' }];
  const swipes = { u1: { a: true, b: true }, u2: { a: false, b: true } };
  assert.equal(F.findMatch(['u1', 'u2'], swipes, deck).id, 'b');
  assert.equal(F.findMatch(['u1', 'u2'], { u1: { a: true }, u2: { a: false } }, deck), null);
});

test('vibe ticket ignores free items and respects subway', () => {
  const liked = [{ subtype: 'thai', price: 2 }, { subtype: 'thai', price: 2 }, { subtype: 'drama', price: 0 }];
  const walker = F.vibeCard({ name: 'Mo', budget: 3, maxWalkMin: 12, canTravel: false }, liked);
  assert.equal(walker.text, "Mo's ticket: $$ · thai, drama · walks up to 12 min");
  const rider = F.vibeCard({ name: 'Mo', budget: 3, maxWalkMin: 12, canTravel: true }, [{ subtype: 'drama', price: 0 }]);
  assert.equal(rider.text, "Mo's ticket: $$$ · drama · takes the subway");
});

test('near-unanimous match for groups of 3+', () => {
  assert.equal(F.yesNeeded(2), 2);
  assert.equal(F.yesNeeded(3), 2);
  assert.equal(F.yesNeeded(5), 4);
  const deck = [{ id: 'a' }];
  const swipes = { u1: { a: true }, u2: { a: true }, u3: { a: false } };
  assert.equal(F.findMatch(['u1', 'u2', 'u3'], swipes, deck, 2).id, 'a');
  assert.equal(F.findMatch(['u1', 'u2', 'u3'], swipes, deck, 3), null);
});

test('streaming stays out of a lunch deck and is capped late at night', () => {
  const lunch = F.buildDeck(places, [base], { hour: 12, categories: ['eat', 'watch'] });
  assert.equal(lunch.deck.filter((p) => p.category === 'watch').length, 0);
  const late = F.buildDeck(places, [base], { hour: 22, categories: ['eat', 'drink', 'watch'] });
  assert.ok(late.deck.filter((p) => p.category === 'watch').length <= 2);
  const watchOnly = F.buildDeck(places, [base], { hour: 12, categories: ['watch'] });
  assert.equal(watchOnly.deck.length, 8);
});

test('thin decks loosen walk first, then budget, and say so', () => {
  const strict = { ...base, canTravel: false, maxWalkMin: 5, budget: 1 };
  const r = F.buildDeck(places, [strict], { hour: 19, categories: ['eat', 'drink', 'do'] });
  assert.ok(r.relaxed.some((n) => n.startsWith('Stretched walk')), JSON.stringify(r.relaxed));
  assert.ok(r.deck.length > 0);
});

test('top blocker names a filter the host can loosen', () => {
  const g = F.mergeProfiles([{ ...base, canTravel: false, maxWalkMin: 5 }]);
  const b = F.topBlocker({ distance: 30, budget: 4, weather: 50 }, g);
  assert.equal(b.what, 'walk');
  assert.equal(b.action, 'Allow 10 min walk');
  assert.equal(b.prompt, 'The 5-minute walk limit cut the most. Loosen it?');
  const d = F.topBlocker({ diet: 20, distance: 5 }, g, ['eat', 'drink']);
  assert.equal(d.what, 'categories');
  assert.equal(d.action, 'Add Do and Watch');
});
