// Core group logic: merge profiles, filter places, rank the deck, find matches.
// Pure functions only, so they can be unit-tested without a server.

const WALK_KM_PER_MIN = 0.0833; // ~5 km/h
const STREET_FACTOR = 1.3;      // real routes are longer than straight lines
const TRAVEL_RADIUS_KM = 5;     // used when everyone is willing to ride/drive
const DIETS = ['vegetarian', 'vegan', 'gluten-free', 'halal', 'kosher'];

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function walkMinutes(a, b) {
  return Math.round((haversineKm(a, b) * STREET_FACTOR) / WALK_KM_PER_MIN);
}

// Combine everyone's profile into one set of group constraints.
function mergeProfiles(members) {
  if (!members.length) throw new Error('No members');
  const located = members.filter((m) => m.location);
  const center = located.length
    ? {
        lat: located.reduce((s, m) => s + m.location.lat, 0) / located.length,
        lng: located.reduce((s, m) => s + m.location.lng, 0) / located.length,
      }
    : null;
  const allTravel = members.every((m) => m.canTravel);
  const maxWalkMin = Math.min(...members.map((m) => m.maxWalkMin ?? 15));
  return {
    budget: Math.min(...members.map((m) => m.budget ?? 2)),
    maxWalkMin,
    allTravel,
    radiusKm: allTravel ? TRAVEL_RADIUS_KM : (maxWalkMin * WALK_KM_PER_MIN) / STREET_FACTOR,
    center,
    minTempF: Math.max(...members.map((m) => m.minTempF ?? 50)),
    okRain: members.every((m) => m.okRain),
    diet: [...new Set(members.flatMap((m) => m.diet || []))].filter((d) => DIETS.includes(d)),
  };
}

function outdoorAllowed(group, weather) {
  if (!weather) return true;
  if (weather.tempF < group.minTempF) return false;
  if (weather.raining && !group.okRain) return false;
  return true;
}

// hours: { open: 11, close: 23 } in 24h; close may exceed 24 for late nights.
function isOpenAt(place, hour) {
  if (!place.hours) return true;
  const { open, close } = place.hours;
  return (hour >= open && hour < close) || (hour + 24 >= open && hour + 24 < close);
}

// Returns { kept: [...places with distance], removed: { reason: count } }
function filterPlaces(places, group, opts = {}) {
  const { weather, hour = new Date().getHours(), categories } = opts;
  const outdoorOk = outdoorAllowed(group, weather);
  const removed = {};
  const drop = (r) => (removed[r] = (removed[r] || 0) + 1);
  const kept = [];
  for (const p of places) {
    if (categories && categories.length && !categories.includes(p.category)) { drop('category'); continue; }
    if (p.price > group.budget) { drop('budget'); continue; }
    if (group.diet.length && !group.diet.every((d) => (p.diet || []).includes(d))) { drop('diet'); continue; }
    if (p.outdoor && !outdoorOk) { drop('weather'); continue; }
    if (!isOpenAt(p, hour)) { drop('closed'); continue; }
    let distKm = null, walkMin = null;
    if (p.lat != null && group.center) {
      distKm = haversineKm(group.center, p);
      if (distKm > group.radiusKm) { drop('distance'); continue; }
      walkMin = walkMinutes(group.center, p);
    }
    kept.push({ ...p, distKm, walkMin });
  }
  return { kept, removed, outdoorOk };
}

// Order the deck: rating + how much the group likes this subtype - distance.
// Streaming has no distance, so it gets a flat penalty instead of a free pass.
const HOME_PENALTY = 0.6;
function rankDeck(places, members, limit = 12) {
  const affinity = (p) => {
    const vals = members.map((m) => (m.tastes && m.tastes[p.subtype]) || 0);
    return vals.reduce((a, b) => a + b, 0) / Math.max(members.length, 1);
  };
  return places
    .map((p) => ({
      ...p,
      score: (p.rating || 3.5) + affinity(p) * 0.5 - (p.distKm != null ? p.distKm * 0.3 : HOME_PENALTY),
    }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);
}

const isLate = (hour) => hour >= 21 || hour < 4;

// Streaming only belongs in a "going out" deck late at night, and never more than ~20% of it.
function balanceDeck(ranked, { categories = [], hour = 19, size = 12 } = {}) {
  const watchOnly = categories.length === 1 && categories[0] === 'watch';
  if (watchOnly) return ranked.slice(0, size);
  const cap = isLate(hour) || !ranked.some((p) => p.category !== 'watch') ? Math.max(1, Math.floor(size * 0.2)) : 0;
  const out = [];
  let watch = 0;
  for (const p of ranked) {
    if (p.category === 'watch') { if (watch >= cap) continue; watch++; }
    out.push(p);
    if (out.length >= size) break;
  }
  return out;
}

// Full pipeline with automatic loosening when the deck is too thin.
// Loosens walk first (doubles it), then budget (+1), and reports what it stretched.
const MIN_DECK = 8;
function buildDeck(places, members, opts = {}) {
  const { weather, hour = new Date().getHours(), categories, size = 12, relax = {} } = opts;
  const base = mergeProfiles(members);
  const steps = [
    { walkBoost: relax.walkBoost || 1, budgetBoost: relax.budgetBoost || 0 },
    { walkBoost: (relax.walkBoost || 1) * 2, budgetBoost: relax.budgetBoost || 0 },
    { walkBoost: (relax.walkBoost || 1) * 2, budgetBoost: (relax.budgetBoost || 0) + 1 },
  ];
  let result;
  for (const s of steps) {
    const group = applyRelax(base, s);
    const filtered = filterPlaces(places, group, { weather, hour, categories });
    const ranked = rankDeck(filtered.kept, members, 100);
    const deck = balanceDeck(ranked, { categories: categories || [], hour, size });
    result = { group, deck, removed: filtered.removed, outdoorOk: filtered.outdoorOk, relaxed: relaxNotes(base, group) };
    if (deck.length >= Math.min(MIN_DECK, size)) break;
  }
  return result;
}

function applyRelax(base, { walkBoost = 1, budgetBoost = 0 }) {
  const g = { ...base };
  if (!g.allTravel && walkBoost > 1) {
    g.maxWalkMin = Math.min(45, Math.round(base.maxWalkMin * walkBoost));
    g.radiusKm = (g.maxWalkMin * WALK_KM_PER_MIN) / STREET_FACTOR;
  }
  if (budgetBoost) g.budget = Math.min(4, base.budget + budgetBoost);
  return g;
}

function relaxNotes(base, g) {
  const notes = [];
  if (g.maxWalkMin !== base.maxWalkMin) notes.push(`Stretched walk to ${g.maxWalkMin} min`);
  if (g.budget !== base.budget) notes.push(`Stretched budget to ${'$'.repeat(g.budget)}`);
  return notes;
}

// The filter that cut the most, phrased as something the host can loosen.
// Dietary needs are never loosened; when they're the main cause, offer more categories instead.
function topBlocker(removed = {}, group, categories = []) {
  const [biggest] = Object.entries(removed).filter(([k]) => k !== 'category').sort((a, b) => b[1] - a[1])[0] || [];
  const missing = ['do', 'watch'].filter((c) => !categories.includes(c));
  if (biggest === 'diet' && missing.length) {
    return { what: 'categories', label: "Your group's dietary needs",
      prompt: "Only a few spots fit everyone's dietary needs. Widen the options?", action: `Add ${missing.map((c) => (c === 'do' ? 'Do' : 'Watch')).join(' and ')}` };
  }
  const loosenable = { distance: 'walk', budget: 'budget' };
  const [reason] = Object.entries(removed).filter(([k]) => loosenable[k]).sort((a, b) => b[1] - a[1])[0] || [];
  if (!reason) return null;
  if (reason === 'distance') {
    const label = `The ${group.maxWalkMin}-minute walk limit`;
    return { what: 'walk', label, prompt: `${label} cut the most. Loosen it?`, action: `Allow ${Math.min(45, group.maxWalkMin * 2)} min walk` };
  }
  const label = `The ${'$'.repeat(group.budget)} budget`;
  return { what: 'budget', label, prompt: `${label} cut the most. Loosen it?`, action: `Allow ${'$'.repeat(Math.min(4, group.budget + 1))}` };
}

// How many yeses make a match: everyone in a pair, everyone but one in a group of 3+.
const yesNeeded = (n) => (n >= 3 ? n - 1 : n);

// swipes: { memberId: { placeId: true|false } }
function findMatch(memberIds, swipes, deck, needed = memberIds.length) {
  if (!memberIds.length) return null;
  for (const p of deck) {
    const yes = memberIds.filter((id) => swipes[id] && swipes[id][p.id] === true).length;
    if (yes >= needed) return p;
  }
  return null;
}

function tally(memberIds, swipes, deck) {
  return deck
    .map((p) => ({ place: p, likes: memberIds.filter((id) => swipes[id] && swipes[id][p.id] === true).length }))
    .filter((r) => r.likes > 0)
    .sort((a, b) => b.likes - a.likes || b.place.score - a.place.score);
}

// Learn tastes from swipes: +1 per like, -0.5 per pass, clamped to [-2, 3].
function updateTastes(tastes, place, liked) {
  const t = { ...(tastes || {}) };
  const v = (t[place.subtype] || 0) + (liked ? 1 : -0.5);
  t[place.subtype] = Math.max(-2, Math.min(3, v));
  return t;
}

// Shareable "ticket" built from what a member liked plus their own stated limits.
// Free items don't count toward price; the walk line is replaced when they take the subway.
function vibeCard(profile, likedPlaces) {
  if (!likedPlaces.length) return null;
  const count = {};
  likedPlaces.forEach((p) => (count[p.subtype] = (count[p.subtype] || 0) + 1));
  const top = Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k);
  const paid = likedPlaces.filter((p) => p.price > 0);
  const price = paid.length
    ? Math.round(paid.reduce((s, p) => s + p.price, 0) / paid.length)
    : profile.budget || 1;
  const reach = profile.canTravel ? 'takes the subway' : `walks up to ${profile.maxWalkMin} min`;
  return { name: profile.name, price: '$'.repeat(Math.max(1, price)), likes: top, reach,
    text: `${profile.name}'s ticket: ${'$'.repeat(Math.max(1, price))} · ${top.join(', ')} · ${reach}` };
}

module.exports = {
  haversineKm, walkMinutes, mergeProfiles, outdoorAllowed, isOpenAt, filterPlaces, rankDeck,
  balanceDeck, buildDeck, topBlocker, yesNeeded, findMatch, tally, updateTastes, vibeCard, DIETS,
};
