// Turns everyone's inputs into concrete, checked options.
// For every place that fits the group's limits and the organizer's archetypes, it works out
// each person's travel, a meet time that respects everyone's "arrive at" / "leave at" time,
// and what doesn't quite work. The AI chooses among these; it never does the arithmetic.

const F = require('./filter');
const T = require('./timing');
const A = require('./archetypes');

const ARRIVE_SLACK_MIN = 15;   // meeting this close to someone's "arrive at" counts as on time
const MIN_CANDIDATES = 3;
const MAX_CANDIDATES = 15;
const HOME_PENALTY = 0.6;      // staying in shouldn't win just because travel is zero

const MODES = ['arrive', 'depart'];

// Validates a person's time preference: { mode: 'arrive'|'depart', at: ISO within the next day }.
function cleanTimePref(t, now = new Date()) {
  if (!t || !MODES.includes(t.mode)) return null;
  const at = Date.parse(t.at);
  if (!Number.isFinite(at) || at < now.getTime() - 3600e3 || at > now.getTime() + 36 * 3600e3) return null;
  return { mode: t.mode, at: new Date(at).toISOString() };
}

// Local hour at the group's location, from the organizer's UTC offset (minutes, as getTimezoneOffset gives it).
const hourOf = (ms, tzOffset = 0) => new Date(ms - tzOffset * 60e3).getUTCHours();
const roundUp5 = (ms) => Math.ceil(ms / 300e3) * 300e3;

// Meet time for one place: late enough for everyone leaving at a set time to get there,
// and as close as possible to the earliest "arrive at" time.
function meetFor(members, travel, fallbackMs) {
  const departs = members.filter((m) => m.timePref && m.timePref.mode === 'depart')
    .map((m) => Date.parse(m.timePref.at) + (travel[m.id] + T.BUFFER_MIN) * 60e3);
  const arrives = members.filter((m) => m.timePref && m.timePref.mode === 'arrive').map((m) => Date.parse(m.timePref.at));
  if (!departs.length && !arrives.length) return fallbackMs;
  return roundUp5(Math.max(departs.length ? Math.max(...departs) : -Infinity, arrives.length ? Math.min(...arrives) : -Infinity));
}

function evaluate(place, members, { fallbackMs, now, tzOffset, chosen }) {
  const travel = {}, how = {};
  for (const m of members) {
    const t = T.travelFor(m.location, place, m.canTravel);
    travel[m.id] = t.minutes; how[m.id] = t.mode;
  }
  const meet = meetFor(members, travel, fallbackMs);
  if (!F.isOpenAt(place, hourOf(meet, tzOffset))) return null;

  const issues = [];
  let offTotal = 0;
  const people = members.map((m) => {
    const leave = how[m.id] === 'home' ? meet : meet - (travel[m.id] + T.BUFFER_MIN) * 60e3;
    let offByMin = 0;
    if (m.timePref && m.timePref.mode === 'arrive') {
      offByMin = Math.round((meet - Date.parse(m.timePref.at)) / 60e3); // + later than asked, - earlier
      if (Math.abs(offByMin) > ARRIVE_SLACK_MIN) {
        issues.push(`${m.name} would arrive ${Math.abs(offByMin)} min ${offByMin > 0 ? 'later' : 'earlier'} than they asked`);
      }
      offTotal += Math.abs(offByMin);
    }
    if (how[m.id] !== 'home' && leave < now) issues.push(`${m.name} would have to leave right now`);
    return { id: m.id, name: m.name, mode: m.timePref ? m.timePref.mode : null, at: m.timePref ? m.timePref.at : null,
      travelMin: travel[m.id], how: how[m.id], leaveBy: new Date(leave).toISOString(), offByMin, from: m.hood || null };
  });
  const travels = Object.values(travel);
  const avgTravel = travels.reduce((a, b) => a + b, 0) / Math.max(travels.length, 1);
  const onlyHome = chosen.length === 1 && chosen[0] === 'nightin';
  const score = (place.rating || 3.5) - offTotal / 20 - avgTravel / 25 - issues.length * 0.5
    - (place.category === 'watch' && !onlyHome ? HOME_PENALTY : 0);
  return {
    id: place.id, name: place.name, emoji: place.emoji, category: place.category, subtype: place.subtype,
    hood: place.hood, price: place.price, rating: place.rating, outdoor: place.outdoor, lat: place.lat, lng: place.lng,
    archetypes: A.matching(place, chosen), meetAt: new Date(meet).toISOString(),
    maxTravelMin: Math.max(0, ...travels), people, issues, score: Math.round(score * 100) / 100,
  };
}

// Every workable option, best first. Loosens walk then budget if too few fit, like the old deck did.
function candidates(places, members, opts = {}) {
  const now = opts.now || new Date();
  const chosen = A.clean(opts.archetypes);
  const tzOffset = opts.tzOffset || 0;
  const fallbackMs = Date.parse(T.resolveMeetAt(null, now));
  const base = F.mergeProfiles(members);
  const relax = opts.relax || {};
  const steps = [
    { walkBoost: relax.walkBoost || 1, budgetBoost: relax.budgetBoost || 0 },
    { walkBoost: (relax.walkBoost || 1) * 2, budgetBoost: relax.budgetBoost || 0 },
    { walkBoost: (relax.walkBoost || 1) * 2, budgetBoost: (relax.budgetBoost || 0) + 1 },
  ];
  // Rough hour for the opening-hours filter; each option is re-checked at its exact meet time.
  const roughHour = hourOf(meetFor(members, Object.fromEntries(members.map((m) => [m.id, 20])), fallbackMs), tzOffset);
  let out;
  for (const s of steps) {
    const group = F.applyRelax(base, s);
    const filtered = F.filterPlaces(places, group, { weather: opts.weather, hour: roughHour });
    const fit = filtered.kept.filter((p) => A.matching(p, chosen).length);
    const list = fit.map((p) => evaluate(p, members, { fallbackMs, now, tzOffset, chosen })).filter(Boolean)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, MAX_CANDIDATES);
    out = { list, group, removed: filtered.removed, outdoorOk: filtered.outdoorOk, relaxed: F.relaxNotes(base, group), archetypes: chosen };
    if (list.length >= MIN_CANDIDATES) break;
  }
  return out;
}

// Rule-based choice, used when the AI is off or fails: best score, then backups that add variety.
// `avoid` holds places people just objected to; they drop to the back unless nothing else is left.
function rulePick(all, avoid = []) {
  if (!all.length) return null;
  const list = [...all.filter((c) => !avoid.includes(c.id)), ...all.filter((c) => avoid.includes(c.id))];
  const [pick, ...rest] = list;
  const seen = new Set(pick.archetypes);
  const varied = rest.filter((c) => c.archetypes.some((a) => !seen.has(a)));
  const backups = [...varied, ...rest.filter((c) => !varied.includes(c))].slice(0, 2);
  const why = (c) => c.issues.length
    ? `Closest fit for the group. ${c.issues[0]}.`
    : `Works for everyone's time, and nobody travels more than ${c.maxTravelMin} min.`;
  return {
    source: 'rules',
    summary: avoid.length && pick.id !== avoid[0]
      ? `Moved away from the last pick after the group's feedback.`
      : `Picked by rating, travel time and everyone's timing.`,
    pick: { id: pick.id, why: why(pick) },
    backups: backups.map((c) => ({ id: c.id, why: why(c) })),
    headsUp: pick.issues,
  };
}

module.exports = { candidates, rulePick, cleanTimePref, meetFor, hourOf, ARRIVE_SLACK_MIN, MODES };
