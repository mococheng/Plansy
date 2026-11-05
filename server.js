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
const { places, hoods } = require('./data/places');

const PORT = process.env.PORT || 3000;
const OFFLINE = process.env.OFFLINE === '1';          // skip live weather calls (used by tests)
const ROOM_TTL_MS = (+process.env.ROOM_TTL_MIN || 30) * 60 * 1000;
const DECK_SIZE = 12;
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
  const decided = new Set([...by('match'), ...by('results')].map((e) => e.room));
  const decidedGroups = twoPlus.filter((r) => decided.has(r));
  return {
    window: 'last 7 days',
    weeklyDecidedGroups: decidedGroups.length,
    funnel: {
      created: created.size,
      twoPlusJoined: twoPlus.length,
      started: new Set(by('started').map((e) => e.room)).size,
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
app.get('/api/health', (_req, res) => res.json({ ok: true, rooms: rooms.size, places: places.length }));
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
function cleanTastes(t) {
  if (!t || typeof t !== 'object') return {};
  return Object.fromEntries(Object.entries(t).slice(0, 60)
    .filter(([k, v]) => typeof k === 'string' && k.length <= 30 && Number.isFinite(v))
    .map(([k, v]) => [k, Math.max(-2, Math.min(3, v))]));
}

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
    location: p.location && isFinite(p.location.lat) ? { lat: +p.location.lat, lng: +p.location.lng } : null,
    hood: typeof p.hood === 'string' ? p.hood.slice(0, 40) : null,
    tastes: cleanTastes(p.tastes),
  };
}

function lobbyState(room) {
  return {
    code: room.code, status: room.status, hostId: room.hostId, categories: room.categories,
    deckSize: room.deck.length, needed: F.yesNeeded(room.members.size), meetAt: room.meetAt,
    members: [...room.members.values()].map((m) => ({
      id: m.id, name: m.name,
      swiped: Object.keys(room.swipes[m.id] || {}).length,
      done: !!room.finished[m.id],
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

async function dealDeck(room) {
  const members = [...room.members.values()];
  const center = F.mergeProfiles(members).center;
  room.weather = room.weatherOverride || room.weather || (await getWeather(center));
  room.planHour = room.hour ?? new Date().getHours();
  const built = F.buildDeck(places, members, {
    weather: room.weather, hour: room.planHour, categories: room.categories, size: DECK_SIZE, relax: room.relax,
  });
  Object.assign(room, built);
  room.blocker = built.deck.length ? null : F.topBlocker(built.removed, built.group, room.categories);
  room.swipes = Object.fromEntries(members.map((m) => [m.id, {}]));
  room.finished = {};
  room.match = null;
  room.resultsSent = false;
  room.status = 'swiping';
}

function deckPayload(r) {
  return {
    deck: r.deck,
    swiped: {},
    weather: r.weather, outdoorOk: r.outdoorOk, hour: r.planHour, relaxed: r.relaxed, blocker: r.blocker,
    hostId: r.hostId,
    group: { budget: r.group.budget, maxWalkMin: r.group.maxWalkMin, allTravel: r.group.allTravel,
      diet: r.group.diet, center: r.group.center },
  };
}

function checkMatch(room) {
  if (room.match) return;
  const ids = [...room.members.keys()];
  const match = F.findMatch(ids, room.swipes, room.deck, F.yesNeeded(ids.length));
  if (match) {
    room.match = match; room.status = 'matched';
    const yes = ids.filter((id) => room.swipes[id][match.id] === true).length;
    io.to(room.code).emit('match', { place: match, yes, of: ids.length });
    sendPlans(room);
    sendResults(room); // a match ends the round: everyone goes to their plan
    logEvent('match', { room: room.code, members: ids.length, yes, place: match.id });
  }
}

io.on('connection', (socket) => {
  let room = null;
  let memberId = null;

  const enter = (r, profile) => {
    room = r;
    memberId = profile.id;
    const existing = r.members.get(profile.id);
    r.members.set(profile.id, existing ? { ...existing, ...profile, tastes: existing.tastes } : profile);
    r.swipes[profile.id] = r.swipes[profile.id] || {};
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
      categories: Array.isArray(msg.categories) && msg.categories.length ? msg.categories : ['eat', 'drink', 'do'],
      hour: Number.isInteger(msg.hour) ? msg.hour : null,
      weatherOverride: msg.weatherOverride || null, relax: {},
      meetAt: T.resolveMeetAt(msg.meetAt), sockets: new Map(), statuses: {},
      members: new Map(), swipes: {}, finished: {}, deck: [], match: null, lastActive: Date.now(),
    };
    rooms.set(r.code, r);
    enter(r, profile);
    logEvent('created', { room: r.code, categories: r.categories });
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
    // Late joiners and reconnects get the current deck plus whatever they already swiped.
    if (r.status !== 'lobby') socket.emit('deck', { ...deckPayload(r), swiped: r.swipes[profile.id] });
    if (r.match) {
      socket.emit('match', { place: r.match, rejoin: true });
      socket.emit('plan', T.personalPlan(r.members.get(profile.id), r.match, r.meetAt));
    }
  });

  socket.on('settings', (msg = {}) => {
    if (!room || memberId !== room.hostId || room.status !== 'lobby') return;
    if (Array.isArray(msg.categories) && msg.categories.length) room.categories = msg.categories;
    touch(room);
    broadcastLobby(room);
  });

  socket.on('start', async (_msg, ack) => {
    if (!room || memberId !== room.hostId) return ack && ack({ ok: false, error: 'Only the host can start' });
    await dealDeck(room);
    logEvent('started', { room: room.code, members: room.members.size, deckSize: room.deck.length, relaxed: room.relaxed });
    io.to(room.code).emit('deck', deckPayload(room));
    broadcastLobby(room);
    ack && ack({ ok: true, count: room.deck.length });
  });

  // Host loosens the filter that cut the most, then everyone gets a fresh deck.
  socket.on('loosen', async ({ what } = {}, ack) => {
    if (!room || memberId !== room.hostId) return ack && ack({ ok: false });
    room.relax = { ...room.relax };
    if (what === 'walk') room.relax.walkBoost = (room.relax.walkBoost || 1) * 2;
    if (what === 'budget') room.relax.budgetBoost = (room.relax.budgetBoost || 0) + 1;
    if (what === 'categories') room.categories = [...new Set([...room.categories, 'do', 'watch'])];
    await dealDeck(room);
    logEvent('loosened', { room: room.code, what, deckSize: room.deck.length });
    io.to(room.code).emit('deck', deckPayload(room));
    broadcastLobby(room);
    ack && ack({ ok: true, count: room.deck.length });
  });

  socket.on('swipe', ({ placeId, liked } = {}) => {
    if (!room || room.status === 'lobby') return;
    const place = room.deck.find((p) => p.id === placeId);
    if (!place) return;
    touch(room);
    room.swipes[memberId] = room.swipes[memberId] || {};
    room.swipes[memberId][placeId] = !!liked;
    const m = room.members.get(memberId);
    if (m) m.tastes = F.updateTastes(m.tastes, place, !!liked);
    socket.emit('tastes', m && m.tastes);

    checkMatch(room);
    if (Object.keys(room.swipes[memberId]).length >= room.deck.length) room.finished[memberId] = true;
    broadcastLobby(room);
    const ids = [...room.members.keys()];
    if (ids.every((id) => room.finished[id])) sendResults(room);
  });

  socket.on('results', () => room && sendResults(room, socket));

  // "On my way" / "Running late" / "Here", shared with the whole group.
  socket.on('status', ({ state } = {}) => {
    if (!room || !room.match || !T.STATUSES[state]) return;
    room.statuses[memberId] = { state, label: T.STATUSES[state], at: new Date().toISOString() };
    touch(room);
    logEvent('status', { room: room.code, state });
    broadcastLobby(room);
  });

  socket.on('shared', ({ kind } = {}) => {
    if (['invite', 'plan', 'ticket', 'calendar', 'assistant'].includes(kind)) logEvent('shared', { room: room && room.code, kind });
  });

  socket.on('disconnect', () => {
    if (!room) return;
    // Idle guests leave the lobby list; the host and anyone who swiped stay so they can reconnect.
    if (room.status === 'lobby' && memberId !== room.hostId) {
      room.members.delete(memberId);
      delete room.swipes[memberId];
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

function sendResults(r, only) {
  const ids = [...r.members.keys()];
  const ranking = F.tally(ids, r.swipes, r.deck).slice(0, 5)
    .map((x) => ({ place: x.place, likes: x.likes, of: ids.length }));
  const vibes = [...r.members.values()].map((m) => ({
    id: m.id,
    card: F.vibeCard(m, r.deck.filter((p) => r.swipes[m.id] && r.swipes[m.id][p.id] === true)),
  }));
  if (!only && !r.resultsSent) { r.resultsSent = true; logEvent('results', { room: r.code, matched: !!r.match }); }
  (only || io.to(r.code)).emit('results', { match: r.match, ranking, vibes });
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
