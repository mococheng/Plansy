// Getting everyone there on time: shared meet time, each person's travel and leave-by.
const { haversineKm, walkMinutes } = require('./filter');

const BUFFER_MIN = 5;          // arrive a few minutes early
const TRANSIT_KM_PER_MIN = 0.4; // ~24 km/h average for subway/cab in the city
const TRANSIT_OVERHEAD_MIN = 8; // getting to the station, waiting, walking out
const NUDGE_BEFORE_MIN = 5;     // reminder fires this long before leave-by

// Best way for one person to reach a place, given what they're willing to do.
function travelFor(from, to, canTravel) {
  if (!from || !to || to.lat == null) return { minutes: 0, mode: 'home' };
  const walk = walkMinutes(from, to);
  if (!canTravel || walk <= 15) return { minutes: walk, mode: 'walk' };
  const transit = Math.round((haversineKm(from, to) * 1.3) / TRANSIT_KM_PER_MIN) + TRANSIT_OVERHEAD_MIN;
  return transit < walk ? { minutes: transit, mode: 'transit' } : { minutes: walk, mode: 'walk' };
}

// Accepts a client-provided ISO meet time if it's sane (within the next 24h), else next quarter hour + 30.
function resolveMeetAt(requested, now = new Date()) {
  const t = requested ? Date.parse(requested) : NaN;
  if (Number.isFinite(t) && t > now.getTime() - 15 * 60e3 && t < now.getTime() + 24 * 3600e3) return new Date(t).toISOString();
  const d = new Date(now.getTime() + 30 * 60e3);
  d.setSeconds(0, 0);
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15);
  return d.toISOString();
}

// One person's plan: when to leave, how they'll get there, when to nudge them.
function personalPlan(member, place, meetAt, now = new Date()) {
  const travel = travelFor(member.location, place, member.canTravel);
  const meet = Date.parse(meetAt);
  const leave = travel.mode === 'home' ? meet : meet - (travel.minutes + BUFFER_MIN) * 60e3;
  const nudge = leave - NUDGE_BEFORE_MIN * 60e3;
  return {
    memberId: member.id,
    meetAt,
    leaveBy: new Date(leave).toISOString(),
    nudgeAt: new Date(nudge).toISOString(),
    travelMin: travel.minutes,
    mode: travel.mode,
    from: member.hood || null,
    leaveNow: leave <= now.getTime(),
  };
}

const STATUSES = { omw: 'On my way', late: 'Running 10 min late', here: "I'm here" };

module.exports = { travelFor, resolveMeetAt, personalPlan, STATUSES, BUFFER_MIN, NUDGE_BEFORE_MIN };
