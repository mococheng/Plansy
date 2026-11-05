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
