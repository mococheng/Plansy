// The AI planning step: Claude reads the group's inputs and the checked options from the
// planner, picks one plan plus two backups, and says why in plain language.
// If there is no API key, or the call fails or is declined, the caller falls back to rulePick.

const AnthropicSDK = require('@anthropic-ai/sdk');
const Anthropic = AnthropicSDK.default || AnthropicSDK;

const MODEL = process.env.PLANNER_MODEL || 'claude-opus-5-5';
const EFFORT = process.env.PLANNER_EFFORT || 'low'; // people are waiting on this, so keep it quick
const TIMEOUT_MS = +process.env.PLANNER_TIMEOUT_MS || 30000;

let client = null;
const enabled = () => !!process.env.ANTHROPIC_API_KEY && process.env.OFFLINE !== '1';
function getClient() {
  if (!client) client = new Anthropic({ timeout: TIMEOUT_MS, maxRetries: 1 });
  return client;
}

const SYSTEM = `You are the planner inside Plansy, an app that helps a group of friends agree on one plan for tonight.
You get the organizer's chosen vibes, each person's limits and timing, and a list of options. Plansy has already checked every option: meet times, each person's travel time and leave-by time, and any timing problems are computed and correct, so rely on those numbers rather than estimating your own.
Choose the single option that suits this group best, then two backups that offer some variety (a different vibe or area when possible).
Weigh, in this order: nobody's timing broken (issues list empty is best), fair travel (no one person travelling far more than the rest), fit with the organizer's vibes, rating, and price.
If people objected to an earlier pick, take their reasons seriously: avoid what they objected to unless every option has the same problem, and say how the new pick addresses it.
Write "why" as one or two short sentences a friend would say, naming people where it helps (for example "Ben only has a 10 min walk and it's open late"). No marketing language.
"summary" is one sentence on how you balanced the group. "heads_up" lists real tradeoffs of the pick the group should know (empty if none).
Only use option ids from the list.`;

const pickShape = (ids) => ({
  type: 'object', additionalProperties: false, required: ['id', 'why'],
  properties: { id: { type: 'string', enum: ids }, why: { type: 'string' } },
});
const schemaFor = (ids) => ({
  type: 'object', additionalProperties: false, required: ['pick', 'backups', 'summary', 'heads_up'],
  properties: {
    pick: pickShape(ids),
    backups: { type: 'array', items: pickShape(ids) },
    summary: { type: 'string' },
    heads_up: { type: 'array', items: { type: 'string' } },
  },
});

function clock(iso, tzOffset) {
  const d = new Date(Date.parse(iso) - tzOffset * 60e3);
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

// What Claude sees: plain facts, clock times in the group's local time, no ids it must not invent.
function briefing({ members, archetypes, list, group, weather, feedback, tzOffset }) {
  const A = require('./archetypes');
  return {
    vibes_chosen_by_organizer: archetypes.map((id) => `${A.byId[id].label}: ${A.byId[id].blurb}`),
    weather: weather ? `${weather.tempF}°F${weather.raining ? ', raining' : ''}` : 'unknown',
    group_limits: { budget: '$'.repeat(group.budget), everyone_ok_with_subway: group.allTravel, diet: group.diet },
    people: members.map((m) => ({
      name: m.name, starting_from: m.hood || 'unknown',
      timing: m.timePref ? `${m.timePref.mode === 'arrive' ? 'wants to arrive at' : 'can leave at'} ${clock(m.timePref.at, tzOffset)}` : 'flexible',
      ok_with_subway: !!m.canTravel,
    })),
    options: list.map((c) => ({
      id: c.id, name: c.name, kind: `${c.subtype} (${c.category})`, area: c.hood, vibes: c.archetypes,
      price: c.price ? '$'.repeat(c.price) : 'free', rating: c.rating, outdoor: !!c.outdoor,
      meet_at: clock(c.meetAt, tzOffset),
      travel: c.people.map((p) => ({ name: p.name, minutes: p.travelMin, by: p.how, leave_by: clock(p.leaveBy, tzOffset) })),
      issues: c.issues,
    })),
    objections_to_last_pick: feedback && feedback.length ? feedback : undefined,
  };
}

// Returns the same shape as planner.rulePick, or null to fall back.
async function aiPick(input) {
  if (!enabled() || !input.list.length) return null;
  const ids = input.list.map((c) => c.id);
  const request = {
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: EFFORT, format: { type: 'json_schema', schema: schemaFor(ids) } },
    system: SYSTEM,
    messages: [{ role: 'user', content: `Plan for this group:\n${JSON.stringify(briefing(input), null, 1)}` }],
  };
  let res;
  try {
    // Server-side fallback re-runs the request on another model if this one declines it.
    res = await getClient().beta.messages.create({ ...request, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  } catch (err) {
    if (!(err instanceof Anthropic.BadRequestError)) { console.warn('[planner] AI call failed:', err.message); return null; }
    try { res = await getClient().messages.create(request); } // retry once without the beta extras
    catch (err2) { console.warn('[planner] AI call failed:', err2.message); return null; }
  }
  if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') return null;
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let out;
  try { out = JSON.parse(text); } catch { return null; }
  if (!out || !out.pick || !ids.includes(out.pick.id)) return null;
  const backups = (out.backups || []).filter((b) => b && ids.includes(b.id) && b.id !== out.pick.id)
    .filter((b, i, arr) => arr.findIndex((x) => x.id === b.id) === i).slice(0, 2);
  return {
    source: 'ai',
    summary: String(out.summary || '').slice(0, 300),
    pick: { id: out.pick.id, why: String(out.pick.why || '').slice(0, 300) },
    backups: backups.map((b) => ({ id: b.id, why: String(b.why || '').slice(0, 300) })),
    headsUp: (out.heads_up || []).map((h) => String(h).slice(0, 200)).slice(0, 4),
  };
}

module.exports = { aiPick, enabled, briefing, schemaFor, MODEL };
