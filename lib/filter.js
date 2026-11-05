// Core group logic: merge profiles, filter places, loosen limits when too little fits.
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

module.exports = {
  haversineKm, walkMinutes, mergeProfiles, outdoorAllowed, isOpenAt, filterPlaces,
  applyRelax, relaxNotes, topBlocker, DIETS, WALK_KM_PER_MIN, STREET_FACTOR,
};
