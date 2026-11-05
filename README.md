# Plansy (local prototype)

Tell it the vibe and when you can go. Plansy's AI planner picks the one plan that works for the whole group.
Everyone's profile (budget, walk limit, weather tolerance, diet, starting point, timing) merges into one set of limits, and every option is checked against each person's real trip before the AI chooses.

## Run it

Needs Node 18 or newer.

```
npm install
npm start
```

The terminal prints two addresses:

- `http://localhost:3000` for this computer
- `http://192.168.x.x:3000` for your Android phone, which must be on the same Wi-Fi

To test a group alone, open the app in two or three browser tabs (use a private window for each extra person so they get separate profiles), or use your phone plus your laptop.

## Try it

1. Enter your name and tap **Start a group**. Adjust budget, walking, weather and diet under **Edit my preferences** (optional).
2. Pick one or more **vibes**: Low-key catch-up, Dinner out, Drinks, Big night out, Get moving, Culture fix or Night in. Say **when you can go** (Arrive at or Leave at, with a time picker) and **where you're coming from**. Under **Testing options** you can simulate cold or rainy weather.
3. Tap **Send invite link**. A friend opening the link types a name, their own time and starting point, and taps once to join.
4. The organizer taps **Plan it**. Plansy checks every place that fits the vibes and everyone's limits, works out a meet time and each person's leave-by, and the AI picks **one plan plus two backups**, saying why in plain words.
5. Everyone taps **Works for me** or **Doesn't work** (Too far, Too pricey, Bad timing, Not my vibe). The organizer sees the answers and taps **Lock it in**, **Lock this in instead** on a backup, or **Re-plan around N objections**.
6. If nothing fits, the organizer gets one button that loosens the limit that cut the most (walk, then budget). Dietary needs are never loosened.

## How the AI planner works

- **Plansy does the arithmetic; Claude does the judgment.** `lib/planner.js` builds every workable option: for each place, each person's travel time (walk, or subway if they're OK with it), a meet time, and each person's leave-by time. A meet time is late enough for everyone who set **Leave at** to get there, and as close as possible to the earliest **Arrive at** time. Anyone who would arrive more than 15 minutes off their time, or would have to leave right now, is listed as an issue.
- **Claude picks.** `lib/ai.js` sends the vibes, everyone's timing and limits, and the checked options to Claude, which returns one pick and two backups as structured JSON. It can only choose from the offered options. On a re-plan it also gets the objections ("Ben said it's too far").
- **Fallback.** With no API key, or if the call fails, times out or is declined, Plansy picks by rating, timing and travel instead and moves off any place people objected to. The pick screen says "Plansy picked" instead of "Plansy AI picked".

## Getting everyone there on time

Locking in a plan ends the round and everyone gets **Your plan**:

- **Meet time:** from the planner, based on everyone's Arrive at / Leave at times. If nobody sets a time, the next quarter hour plus 30 minutes.
- **Personal leave-by time:** from where each person says they're starting. The host picks it when creating the group, friends pick it on the invite card (or in the lobby if they joined by code), and anyone can change it in the lobby or on their plan; the leave-by time updates right away. Exact GPS location works over HTTPS. People who are OK with the subway get the faster of walking or transit, plus a 5-minute buffer.
- **Add to my calendar:** a standard calendar invite (.ics) with two reminders (get ready, then leave now) and a plain-language note an AI assistant can act on.
- **Google Calendar** and **Email it to me:** for assistants that read your calendar or inbox.
- **Send to my AI assistant:** opens the phone's share sheet with the plan and the invite file, so you can pick your assistant app if it appears there. Needs HTTPS (see Known limits).
- **On my way / Running late / I'm here:** shown live to the whole group.

### How this reaches Claude Duet or Meta Muse

Neither assistant documents a way for other apps to push data to it; both read the services you connect, such as email and calendar. So Plansy delivers the plan to those places. Connect your calendar or Gmail to your assistant and it will see the Plansy event and its note.

## How the group limits work

| Setting | Group rule |
|---|---|
| Budget | Lowest budget in the group |
| Walk | Shortest walk limit, from the midpoint of everyone's starting points. If everyone is OK with the subway, radius is 5 km |
| Weather | Live forecast from Open-Meteo (free, no key). Outdoor places drop out if it's colder than anyone's limit, or raining and anyone minds rain |
| Diet | Every member's restriction applies to the whole group |
| Hours | Only places open at the planned meet time |
| Vibes | Only places that fit one of the organizer's vibes. Streaming only counts as Night in |
| Too few options | Under 3: walk limit doubles, then budget goes up one step, and the pick says what was stretched |

The logic lives in `lib/filter.js`, `lib/planner.js` and `lib/archetypes.js` as plain functions.

## Adoption funnel

Every key step is written to `logs/events.jsonl` (created, joined by link or code, planned, locked, shared). Open `http://localhost:3000/api/stats` to see the last 7 days, led by **weekly decided groups**: groups where 2+ people joined and locked in a plan.

## Tests

```
npm test
```

Covers each limit, the planner's timing rules, the AI request shape and its fallback, and real multi-person rooms over sockets: planning, objecting, re-planning, locking in, late joining, a host dropping while sharing the invite, and the stats funnel. Tests never call the AI.

## Put it on the internet

The server reads `PORT` from the host, so no code changes are needed.

**Quick test from your laptop (free, no account):** install Cloudflare's `cloudflared`, run `npm start`, then in a second terminal run:

```
cloudflared tunnel --url http://localhost:3000
```

It prints an `https://….trycloudflare.com` link anyone can open. The link changes every time and only works while your laptop is on.

**Always on (recommended): Railway, Hobby plan $5/month.** Put this folder in a GitHub repo, then in Railway choose New Project → Deploy from GitHub repo. Under Settings → Networking, choose Generate Domain. Under Variables, add `STATS_KEY` with any long random value, and `ANTHROPIC_API_KEY` to turn on the AI planner.

**Free option: Render.** New → Blueprint, pick the repo (it reads `render.yaml`). The free plan sleeps after 15 idle minutes and takes about a minute to wake, so the first person to open an invite waits.

**Settings you can change (environment variables)**

| Variable | Default | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Turns on the AI planner. Without it, Plansy uses its rule-based pick |
| `PLANNER_MODEL` | `claude-opus-5-5` | Claude model the planner uses |
| `PLANNER_EFFORT` | `low` | How hard Claude thinks (`low`, `medium`, `high`). Higher is slower; people are waiting on the pick |
| `PLANNER_TIMEOUT_MS` | 30000 | Give up on the AI and use the rule-based pick after this long |
| `STATS_KEY` | none | Locks `/api/stats`; open it as `/api/stats?key=YOUR_KEY` |
| `MAX_ROOMS` | 500 | Most groups open at once |
| `MAX_MEMBERS` | 12 | Most people per group |
| `CREATES_PER_10_MIN` | 20 | New groups one address can make in 10 minutes |
| `ROOM_TTL_MIN` | 30 | Minutes before an idle group expires |

## Known limits of this prototype

- **Demo data:** 44 fictional NYC places and 8 fictional streaming titles in `data/places.js`.
- **AI cost and wait:** each Plan it or Re-plan is one Claude request (a few seconds). Check your Anthropic usage before sharing widely.
- **Exact location:** phone GPS only works over HTTPS, so on Wi-Fi testing it falls back to the neighborhood picker. Use a tunnel like `ngrok http 3000` or deploy to get HTTPS.
- **Share sheet:** Android only offers "Send to my AI assistant" over HTTPS. On plain Wi-Fi testing, use the calendar invite or "Email it to me".
- **Memory only:** groups are lost when the server restarts or redeploys, and expire after 30 minutes of inactivity. On hosts with temporary disks (Render free, Railway without a volume) the stats log also resets on each deploy.

## Next steps toward the Play Store

1. Replace demo data with the Google Places API (places, hours, price level), TMDB (streaming) and Ticketmaster (events). Cache results to control cost.
2. Wrap the web app for Android with Capacitor or as a Trusted Web Activity, then run the Play closed test.
