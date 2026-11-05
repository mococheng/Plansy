// Plansy local server: serves the app and runs real-time group rooms.
// Run: npm start  → open the printed URL on your phone (same Wi-Fi).

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const F = require('./lib/filter');
const T = require('./lib/timing');
const P = require('./lib/planner');
const AI = require('./lib/ai');
const ARCH = require('./lib/archetypes');
const { places, hoods } = require('./data/places');

const PORT = process.env.PORT || 3000;
const OFFLINE = process.env.OFFLINE === '1';          // skip live weather calls (used by tests)
const ROOM_TTL_MS = (+process.env.ROOM_TTL_MIN || 30) * 60 * 1000;
const LOG_FILE = process.env.EVENT_LOG || path.join(__dirname, 'logs', 'events.jsonl');
// Limits for running on the public internet.
const MAX_ROOMS = +process.env.MAX_ROOMS || 500;
const MAX_MEMBERS = +process.env.MAX_MEMBERS || 12;
const CREATES_PER_10_MIN = +process.env.CREATES_PER_10_MIN || 20;
const STATS_KEY = process.env.STATS_KEY || ''; // set this when hosted so only you can see /api/stats

const rooms = new Map();

// ---------- Event log: one JSON line per event, for the adoption funnel ----------
function logEvent(type, data = {}) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify({ t: new Date().toISOString(), type, ...data }) + '\n');
  } catch { /* logging must never break the app */ }
}

function funnel() {
  let lines = [];
  try { lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  const weekAgo = Date.now() - 7 * 864e5;
  const recent = lines.filter((e) => Date.parse(e.t) >= weekAgo);
  const by = (type) => recent.filter((e) => e.type === type);
  const created = new Set(by('created').map((e) => e.room));
  const joiners = {};
  by('joined').forEach((e) => (joiners[e.room] = (joiners[e.room] || 1) + 1));
  const twoPlus = [...created].filter((r) => (joiners[r] || 1) >= 2);
  const decided = new Set([...by('locked'), ...by('match'), ...by('results')].map((e) => e.room));
  const decidedGroups = twoPlus.filter((r) => decided.has(r));
  return {
    window: 'last 7 days',
    weeklyDecidedGroups: decidedGroups.length,
    funnel: {
      created: created.size,
      twoPlusJoined: twoPlus.length,
      planned: new Set([...by('planned'), ...by('started')].map((e) => e.room)).size,
      decided: decidedGroups.length,
      shared: by('shared').length,
    },
    joinsByLink: by('joined').filter((e) => e.via === 'link').length,
    joinsByCode: by('joined').filter((e) => e.via === 'code').length,
  };
}

// ---------- HTTP ----------
const app = express();
app.set('trust proxy', 1); // hosts like Render and Railway sit behind a proxy
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/hoods', (_req, res) => res.json(hoods));
app.get('/api/archetypes', (_req, res) => res.json(ARCH.publicList()));
app.get('/api/health', (_req, res) => res.json({ ok: true, rooms: rooms.size, places: places.length, ai: AI.enabled() }));
app.get('/api/stats', (req, res) => {
  if (STATS_KEY && req.query.key !== STATS_KEY) return res.status(404).end();
  res.json(funnel());
});
app.get('/api/room/:code', (req, res) => {
  const r = rooms.get(String(req.params.code).toUpperCase());
  if (!r) return res.status(404).json({ exists: false });
  const host = r.members.get(r.hostId);
  res.json({ exists: true, hostName: host ? host.name : 'A friend', status: r.status, count: r.members.size });
});
app.get('/api/weather', async (req, res) => {
  res.json(await getWeather({ lat: +req.query.lat || 40.73, lng: +req.query.lng || -73.99 }));
});

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 16 * 1024 });

// Per-address cap on group creation, so one person can't flood the server.
const createLog = new Map();
function allowCreate(ip) {
  const now = Date.now(), recent = (createLog.get(ip) || []).filter((t) => now - t < 10 * 60e3);
  if (recent.length >= CREATES_PER_10_MIN) { createLog.set(ip, recent); return false; }
  recent.push(now); createLog.set(ip, recent);
  if (createLog.size > 5000) createLog.clear();
  return true;
}
const clientIp = (socket) => String(socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || '').split(',')[0].trim();

// Live weather from Open-Meteo (free, no key). Falls back to a mild default.
async function getWeather(center) {
  const fallback = { tempF: 55, raining: false, source: 'default' };
  if (OFFLINE || !center) return fallback;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${center.lat}&longitude=${center.lng}` +
      `&current=temperature_2m,precipitation&temperature_unit=fahrenheit`;
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    return { tempF: Math.round(j.current.temperature_2m), raining: j.current.precipitation > 0, source: 'open-meteo' };
  } catch {
    return fallback;
  }
}

function newCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do c = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  while (rooms.has(c));
  return c;
}

// Where someone is starting from: a neighborhood or their exact GPS position.
// Bad or out-of-range coordinates are dropped rather than trusted.
function cleanLocation(p = {}) {
  const l = p.location;
  const ok = l && Number.isFinite(+l.lat) && Number.isFinite(+l.lng) && Math.abs(+l.lat) <= 90 && Math.abs(+l.lng) <= 180;
  return {
    location: ok ? { lat: +l.lat, lng: +l.lng } : null,
    hood: ok && typeof p.hood === 'string' ? p.hood.slice(0, 40) : null,
  };
}

function cleanProfile(p = {}) {
  return {
    id: String(p.id || Math.random().toString(36).slice(2)),
    name: String(p.name || 'Guest').trim().slice(0, 24) || 'Guest',
    budget: Math.min(4, Math.max(1, +p.budget || 2)),
    maxWalkMin: Math.min(60, Math.max(5, +p.maxWalkMin || 15)),
    canTravel: !!p.canTravel,
    minTempF: Math.min(90, Math.max(0, +p.minTempF || 50)),
    okRain: !!p.okRain,
    diet: Array.isArray(p.diet) ? p.diet.filter((d) => F.DIETS.includes(d)) : [],
    ...cleanLocation(p),
    timePref: P.cleanTimePref(p.timePref),
  };
}

function lobbyState(room) {
  return {
    code: room.code, status: room.status, hostId: room.hostId, archetypes: room.archetypes,
    aiOn: AI.enabled(),
    members: [...room.members.values()].map((m) => ({
      id: m.id, name: m.name,
      from: m.hood || null,
      timePref: m.timePref || null,
      reaction: room.reactions[m.id] || null,
      status: room.statuses[m.id] || null,
    })),
  };
}

const touch = (r) => (r.lastActive = Date.now());
const broadcastLobby = (room) => io.to(room.code).emit('lobby', lobbyState(room));

// Groups expire after a period of inactivity instead of vanishing when someone's
// connection drops (e.g. switching to a chat app to share the invite).
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) if (now - r.lastActive > ROOM_TTL_MS) rooms.delete(code);
}, 60 * 1000).unref();

// Build checked options, let the AI choose (or the rules, as a fallback), and show everyone.
const findCand = (room, id) => room.candidates && room.candidates.find((c) => c.id === id);
function proposalPayload(room) {
  const pr = room.proposal;
  if (!pr) return null;
  if (pr.none) return { ...pr, round: room.round };
  const withPlace = (x) => ({ ...x, place: findCand(room, x.id) });
  return { ...pr, pick: withPlace(pr.pick), backups: pr.backups.map(withPlace), round: room.round };
}

async function runPlan(room, feedback) {
  const members = [...room.members.values()];
  const center = F.mergeProfiles(members).center;
  room.weather = room.weatherOverride || room.weather || (await getWeather(center));
  const built = P.candidates(places, members, {
    archetypes: room.archetypes, weather: room.weather, tzOffset: room.tzOffset, relax: room.relax,
  });
  room.candidates = built.list;
  room.relaxed = built.relaxed;
  room.reactions = {};
  room.round = (room.round || 0) + 1;
  if (!built.list.length) {
    room.proposal = { none: true, blocker: F.topBlocker(built.removed, built.group, ['eat', 'drink', 'do', 'watch', 'go']), relaxed: built.relaxed };
    room.status = 'proposed';
    return;
  }
  const input = { members, archetypes: built.archetypes, list: built.list, group: built.group, weather: room.weather, feedback, tzOffset: room.tzOffset };
  const avoid = feedback.length && room.proposal && !room.proposal.none ? [room.proposal.pick.id] : [];
  const choice = (await AI.aiPick(input)) || P.rulePick(built.list, avoid);
  room.proposal = { ...choice, relaxed: built.relaxed, weather: room.weather };
  room.status = 'proposed';
}

// What people said about the last pick, in words the AI can act on.
function feedbackFor(room) {
  const pick = room.proposal && !room.proposal.none && findCand(room, room.proposal.pick.id);
  return Object.entries(room.reactions).filter(([, r]) => !r.ok).map(([id, r]) => {
    const m = room.members.get(id);
    return `${m ? m.name : 'Someone'} said ${pick ? pick.name : 'the last pick'} doesn't work: ${r.reason || 'no reason given'}`;
  });
}

function lock(room, id) {
  const c = findCand(room, id);
  if (!c) return false;
  room.match = c;
  room.meetAt = c.meetAt;
  room.status = 'locked';
  return true;
}

io.on('connection', (socket) => {
  let room = null;
  let memberId = null;

  const enter = (r, profile) => {
    room = r;
    memberId = profile.id;
    const existing = r.members.get(profile.id);
    r.members.set(profile.id, existing ? { ...existing, ...profile } : profile);
    socket.join(r.code);
    r.sockets.set(profile.id, socket.id);
    touch(r);
  };

  socket.on('create', (msg = {}, ack) => {
    if (rooms.size >= MAX_ROOMS) return ack && ack({ ok: false, error: 'Plansy is busy right now. Try again in a few minutes.' });
    if (!allowCreate(clientIp(socket))) return ack && ack({ ok: false, error: 'Too many new groups. Wait a few minutes and try again.' });
    const profile = cleanProfile(msg.profile);
    const r = {
      code: newCode(), hostId: profile.id, status: 'lobby',
      archetypes: ARCH.clean(msg.archetypes),
      tzOffset: Number.isFinite(+msg.tzOffset) && Math.abs(+msg.tzOffset) <= 840 ? +msg.tzOffset : 0,
      weatherOverride: msg.weatherOverride || null, relax: {},
      meetAt: null, sockets: new Map(), statuses: {}, reactions: {},
      members: new Map(), candidates: [], proposal: null, match: null, lastActive: Date.now(),
    };
    rooms.set(r.code, r);
    enter(r, profile);
    logEvent('created', { room: r.code, archetypes: r.archetypes });
    ack && ack({ ok: true, code: r.code });
    broadcastLobby(r);
  });

  socket.on('join', (msg = {}, ack) => {
    const r = rooms.get(String(msg.code || '').toUpperCase());
    if (!r) return ack && ack({ ok: false, error: 'expired' });
    const profile = cleanProfile(msg.profile);
    const isNew = !r.members.has(profile.id);
    if (isNew && r.members.size >= MAX_MEMBERS) return ack && ack({ ok: false, error: 'full' });
    enter(r, profile);
    if (isNew) logEvent('joined', { room: r.code, via: msg.via === 'link' ? 'link' : 'code', late: r.status !== 'lobby' });
    const host = r.members.get(r.hostId);
    ack && ack({ ok: true, code: r.code, status: r.status, hostName: host ? host.name : '' });
    broadcastLobby(r);
    // Late joiners and reconnects see the current proposal, or the locked plan.
    if (r.status === 'proposed') socket.emit('proposal', proposalPayload(r));
    if (r.match) {
      socket.emit('locked', { place: r.match, meetAt: r.meetAt, rejoin: true });
      socket.emit('plan', T.personalPlan(r.members.get(profile.id), r.match, r.meetAt));
    }
  });

  socket.on('settings', (msg = {}) => {
    if (!room || memberId !== room.hostId || room.status === 'locked') return;
    if (Array.isArray(msg.archetypes) && msg.archetypes.length) room.archetypes = ARCH.clean(msg.archetypes);
    touch(room);
    broadcastLobby(room);
  });

  // Host asks Plansy to plan (or re-plan, taking objections into account).
  socket.on('plan', async (_msg, ack) => {
    if (!room || memberId !== room.hostId) return ack && ack({ ok: false, error: 'Only the organizer can plan' });
    if (room.status === 'planning' || room.status === 'locked') return ack && ack({ ok: false, error: 'Already planning' });
    const feedback = room.status === 'proposed' ? feedbackFor(room) : [];
    const prev = room.status;
    room.status = 'planning';
    broadcastLobby(room);
    try { await runPlan(room, feedback); }
    catch (e) { room.status = prev; broadcastLobby(room); return ack && ack({ ok: false, error: "Couldn't plan right now. Try again." }); }
    logEvent('planned', { room: room.code, members: room.members.size, options: room.candidates.length,
      source: room.proposal.source || 'none', replan: feedback.length > 0 });
    io.to(room.code).emit('proposal', proposalPayload(room));
    broadcastLobby(room);
    ack && ack({ ok: true });
  });

  // Host loosens the filter that cut the most when nothing fits, then plans again.
  socket.on('loosen', async ({ what } = {}, ack) => {
    if (!room || memberId !== room.hostId || room.status === 'locked') return ack && ack({ ok: false });
    room.relax = { ...room.relax };
    if (what === 'walk') room.relax.walkBoost = (room.relax.walkBoost || 1) * 2;
    if (what === 'budget') room.relax.budgetBoost = (room.relax.budgetBoost || 0) + 1;
    if (what === 'categories') room.archetypes = ARCH.clean([...room.archetypes, 'active', 'culture', 'nightin']);
    room.status = 'planning'; broadcastLobby(room);
    await runPlan(room, []);
    logEvent('loosened', { room: room.code, what, options: room.candidates.length });
    io.to(room.code).emit('proposal', proposalPayload(room));
    broadcastLobby(room);
    ack && ack({ ok: true });
  });

  // "Works for me" / "Doesn't work" on the current pick.
  socket.on('react', ({ ok, reason } = {}) => {
    if (!room || room.status !== 'proposed' || !room.proposal || room.proposal.none) return;
    room.reactions[memberId] = { ok: !!ok, reason: ok ? null : String(reason || '').slice(0, 80) || null };
    touch(room);
    broadcastLobby(room);
  });

  // Host locks in the pick or one of the backups.
  socket.on('choose', ({ id } = {}, ack) => {
    if (!room || memberId !== room.hostId || room.status !== 'proposed') return ack && ack({ ok: false });
    const pr = room.proposal;
    if (!pr || pr.none || ![pr.pick.id, ...pr.backups.map((b) => b.id)].includes(id) || !lock(room, id)) return ack && ack({ ok: false });
    const ids = [...room.members.keys()];
    logEvent('locked', { room: room.code, members: ids.length, place: id, wasPick: id === pr.pick.id,
      objections: Object.values(room.reactions).filter((r) => !r.ok).length });
    io.to(room.code).emit('locked', { place: room.match, meetAt: room.meetAt });
    sendPlans(room);
    broadcastLobby(room);
    ack && ack({ ok: true });
  });

  // Someone sets or changes when they can go.
  socket.on('time', ({ timePref } = {}, ack) => {
    if (!room || !room.members.has(memberId)) return ack && ack({ ok: false });
    if (room.status === 'locked') return ack && ack({ ok: false, error: 'locked' });
    room.members.get(memberId).timePref = P.cleanTimePref(timePref);
    touch(room);
    broadcastLobby(room);
    ack && ack({ ok: true });
  });

  // Someone sets or changes where they're starting from. Before a match this moves the
  // group's search center (on the next deal); after a match it recomputes their leave-by.
  socket.on('location', (msg = {}, ack) => {
    if (!room || !room.members.has(memberId)) return ack && ack({ ok: false });
    const loc = cleanLocation(msg);
    if (!loc.location) return ack && ack({ ok: false, error: 'bad location' });
    Object.assign(room.members.get(memberId), loc);
    touch(room);
    broadcastLobby(room);
    if (room.match) socket.emit('plan', T.personalPlan(room.members.get(memberId), room.match, room.meetAt));
    ack && ack({ ok: true });
  });

  // "On my way" / "Running late" / "Here", shared with the whole group.
  socket.on('status', ({ state } = {}) => {
    if (!room || !room.match || !T.STATUSES[state]) return;
    room.statuses[memberId] = { state, label: T.STATUSES[state], at: new Date().toISOString() };
    touch(room);
    logEvent('status', { room: room.code, state });
    broadcastLobby(room);
  });

  socket.on('shared', ({ kind } = {}) => {
    if (['invite', 'plan', 'calendar', 'assistant'].includes(kind)) logEvent('shared', { room: room && room.code, kind });
  });

  socket.on('disconnect', () => {
    if (!room) return;
    // Idle guests leave the lobby list; once planning starts everyone stays so they can reconnect.
    if (room.status === 'lobby' && memberId !== room.hostId) {
      room.members.delete(memberId);
      delete room.reactions[memberId];
    }
    broadcastLobby(room);
  });
});

// Each person gets their own leave-by time, based on where they're coming from.
function sendPlans(r) {
  for (const m of r.members.values()) {
    const sid = r.sockets.get(m.id);
    if (sid) io.to(sid).emit('plan', T.personalPlan(m, r.match, r.meetAt));
  }
}

function lanUrls() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i.address}:${PORT}`);
}

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\nPlansy is running.\n  On this computer: http://localhost:${PORT}`);
    lanUrls().forEach((u) => console.log(`  On your phone (same Wi-Fi): ${u}`));
    console.log(`  Adoption funnel: http://localhost:${PORT}/api/stats\n`);
  });
}

module.exports = { server, rooms, funnel };
