# Plansy (local prototype)

Swipe with friends and match on what to do: eat, drink, do, watch or go.
Everyone's profile (budget, walk limit, weather tolerance, diet, location) merges into one group filter.

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
2. Pick categories. Under **Testing options** you can simulate cold or rainy weather.
3. Tap **Send invite link**. A friend opening the link sees "Mo invited you to plan tonight", types a name and taps once to join.
4. The host taps **Start swiping**. Swipe right or tap **I'm in**; swipe left or tap **Pass**. Arrow keys work on a laptop. Everyone's progress shows under the card, and people can join late.
5. A match needs every yes in a pair, and all but one yes in a group of 3 or more. **Share the plan** sends "We're going to X" to the group chat. After the deck, everyone gets the ranked picks and a shareable ticket.
6. If nothing fits, the host gets one button that loosens the filter that cut the most (walk, then budget). Dietary needs are never loosened; the app offers more categories instead.

## Getting everyone there on time

A match ends the round and everyone gets **Your plan**:

- **Meet time:** from the host's choice (Lunch 12:30, Dinner 7pm, Late 10pm), or the next quarter hour plus 30 minutes for "Now".
- **Personal leave-by time:** from where each person says they're starting. The host picks it when creating the group, friends pick it on the invite card (or in the lobby if they joined by code), and anyone can change it in the lobby or on their plan; the leave-by time updates right away. Exact GPS location works over HTTPS. People who are OK with the subway get the faster of walking or transit, plus a 5-minute buffer.
- **Add to my calendar:** a standard calendar invite (.ics) with two reminders (get ready, then leave now) and a plain-language note an AI assistant can act on.
- **Google Calendar** and **Email it to me:** for assistants that read your calendar or inbox.
- **Send to my AI assistant:** opens the phone's share sheet with the plan and the invite file, so you can pick your assistant app if it appears there. Needs HTTPS (see Known limits).
- **On my way / Running late / I'm here:** shown live to the whole group.

### How this reaches Claude Duet or Meta Muse

Neither assistant documents a way for other apps to push data to it; both read the services you connect, such as email and calendar. So Plansy delivers the plan to those places. Connect your calendar or Gmail to your assistant and it will see the Plansy event and its note.

## How the group filter works

| Setting | Group rule |
|---|---|
| Budget | Lowest budget in the group |
| Walk | Shortest walk limit, from the midpoint of everyone's locations. If everyone is OK with the subway, radius is 5 km |
| Weather | Live forecast from Open-Meteo (free, no key). Outdoor places drop out if it's colder than anyone's limit, or raining and anyone minds rain |
| Diet | Every member's restriction applies to the whole group |
| Hours | Only places open at the chosen time |
| Thin deck | Under 8 cards: walk limit doubles, then budget goes up one step. A dark chip says what was stretched |
| Streaming | Only in late-night decks (or Watch-only), at most 2 of 12 cards |
| Order | Rating, plus tastes learned from swipes, minus distance. 12 cards per deck |

The logic lives in `lib/filter.js` as plain functions.

## Adoption funnel

Every key step is written to `logs/events.jsonl` (created, joined by link or code, started, match, results, shared). Open `http://localhost:3000/api/stats` to see the last 7 days, led by **weekly decided groups**: groups where 2+ people joined and reached a match or results.

## Tests

```
npm test
```

Covers each filter rule, deck balancing and loosening, and real multi-person rooms over sockets: matching, late joining, reconnecting, a host dropping while sharing the invite, and the stats funnel.

## Put it on the internet

The server reads `PORT` from the host, so no code changes are needed.

**Quick test from your laptop (free, no account):** install Cloudflare's `cloudflared`, run `npm start`, then in a second terminal run:

```
cloudflared tunnel --url http://localhost:3000
```

It prints an `https://….trycloudflare.com` link anyone can open. The link changes every time and only works while your laptop is on.

**Always on (recommended): Railway, Hobby plan $5/month.** Put this folder in a GitHub repo, then in Railway choose New Project → Deploy from GitHub repo. Under Settings → Networking, choose Generate Domain. Under Variables, add `STATS_KEY` with any long random value.

**Free option: Render.** New → Blueprint, pick the repo (it reads `render.yaml`). The free plan sleeps after 15 idle minutes and takes about a minute to wake, so the first person to open an invite waits.

**Settings you can change (environment variables)**

| Variable | Default | What it does |
|---|---|---|
| `STATS_KEY` | none | Locks `/api/stats`; open it as `/api/stats?key=YOUR_KEY` |
| `MAX_ROOMS` | 500 | Most groups open at once |
| `MAX_MEMBERS` | 12 | Most people per group |
| `CREATES_PER_10_MIN` | 20 | New groups one address can make in 10 minutes |
| `ROOM_TTL_MIN` | 30 | Minutes before an idle group expires |

## Known limits of this prototype

- **Demo data:** 44 fictional NYC places and 8 fictional streaming titles in `data/places.js`.
- **Exact location:** phone GPS only works over HTTPS, so on Wi-Fi testing it falls back to the neighborhood picker. Use a tunnel like `ngrok http 3000` or deploy to get HTTPS.
- **Share sheet:** Android only offers "Send to my AI assistant" over HTTPS. On plain Wi-Fi testing, use the calendar invite or "Email it to me".
- **Memory only:** groups are lost when the server restarts or redeploys, and expire after 30 minutes of inactivity. On hosts with temporary disks (Render free, Railway without a volume) the stats log also resets on each deploy.

## Next steps toward the Play Store

1. Replace demo data with the Google Places API (places, hours, price level), TMDB (streaming) and Ticketmaster (events). Cache results to control cost.
2. Wrap the web app for Android with Capacitor or as a Trusted Web Activity, then run the Play closed test.
