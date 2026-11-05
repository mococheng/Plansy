// Vibe archetypes the organizer picks from. Each one says which places fit it,
// so the planner can offer real options and the AI can explain the choice.

const ARCHETYPES = [
  { id: 'catchup', label: 'Low-key catch-up', emoji: '☕',
    blurb: 'Somewhere easy to talk: coffee, wine, a casual bite.',
    fits: (p) => ['coffee', 'wine bar', 'brunch', 'deli', 'ramen', 'vietnamese', 'thai', 'trivia'].includes(p.subtype) },
  { id: 'dinner', label: 'Dinner out', emoji: '🍽️',
    blurb: 'A proper sit-down meal.',
    fits: (p) => p.category === 'eat' },
  { id: 'drinks', label: 'Drinks', emoji: '🍸',
    blurb: 'Bars, rooftops and beer gardens.',
    fits: (p) => p.category === 'drink' && p.subtype !== 'coffee' },
  { id: 'bignight', label: 'Big night out', emoji: '🎤',
    blurb: 'Loud and late: karaoke, comedy, shows, cocktails.',
    fits: (p) => ['karaoke', 'comedy', 'cocktail bar', 'rooftop bar', 'dive bar', 'concert', 'show', 'sports'].includes(p.subtype) },
  { id: 'active', label: 'Get moving', emoji: '🎳',
    blurb: 'Play something: bowling, mini golf, escape rooms, parks.',
    fits: (p) => ['bowling', 'mini golf', 'arcade', 'escape room', 'class', 'outdoors', 'park'].includes(p.subtype) },
  { id: 'culture', label: 'Culture fix', emoji: '🎭',
    blurb: 'Museums, markets, shows and outdoor movies.',
    fits: (p) => ['museum', 'show', 'market', 'outdoor movie', 'concert', 'comedy'].includes(p.subtype) },
  { id: 'nightin', label: 'Night in', emoji: '🍿',
    blurb: 'Stay home and stream something together.',
    fits: (p) => p.category === 'watch' },
];

const IDS = ARCHETYPES.map((a) => a.id);
const byId = Object.fromEntries(ARCHETYPES.map((a) => [a.id, a]));
const DEFAULT = ['catchup', 'dinner', 'drinks'];

function clean(list) {
  const ids = Array.isArray(list) ? [...new Set(list.filter((x) => IDS.includes(x)))] : [];
  return ids.length ? ids : DEFAULT;
}

// Archetype ids (from the chosen ones) that a place fits. Streaming only ever counts as a night in,
// even when its genre (say, comedy) shares a name with a going-out subtype.
const matching = (place, chosen) => chosen.filter((id) =>
  (place.category === 'watch' ? id === 'nightin' : id !== 'nightin') && byId[id].fits(place));

// What the client needs to render the picker.
const publicList = () => ARCHETYPES.map(({ id, label, emoji, blurb }) => ({ id, label, emoji, blurb }));

module.exports = { ARCHETYPES, IDS, DEFAULT, byId, clean, matching, publicList };
