// Demo data: fictional NYC places so the app works with no API keys.
// Swap for Google Places / TMDB / Ticketmaster later (see README).

const hoods = {
  'East Village': { lat: 40.7265, lng: -73.9815 },
  'West Village': { lat: 40.7358, lng: -74.0036 },
  SoHo: { lat: 40.7233, lng: -74.003 },
  'Lower East Side': { lat: 40.715, lng: -73.9843 },
  Chelsea: { lat: 40.7465, lng: -74.0014 },
  Midtown: { lat: 40.7549, lng: -73.984 },
  Williamsburg: { lat: 40.7081, lng: -73.9571 },
  FiDi: { lat: 40.7075, lng: -74.0113 },
};

// [name, category, subtype, price, hood, dLat, dLng, outdoor, diet, open, close, rating, emoji]
const V = ['vegetarian'], VG = ['vegetarian', 'vegan'], VGF = ['vegetarian', 'vegan', 'gluten-free'];
const rows = [
  ['Pho Ngon Corner', 'eat', 'vietnamese', 1, 'East Village', 0.001, 0.002, false, ['gluten-free'], 11, 23, 4.6, '🍜'],
  ['Banh Mi Brothers', 'eat', 'vietnamese', 1, 'Lower East Side', -0.001, 0.001, false, V, 10, 21, 4.4, '🥖'],
  ['Little Saigon Grill', 'eat', 'vietnamese', 2, 'Williamsburg', 0.002, -0.001, true, VGF, 12, 23, 4.5, '🍲'],
  ['Thai Bodega', 'eat', 'thai', 1, 'East Village', -0.002, 0.003, false, VG, 11, 24, 4.3, '🍛'],
  ['Basil & Lime', 'eat', 'thai', 2, 'West Village', 0.001, 0.001, false, VGF, 12, 22, 4.5, '🌶️'],
  ['Slice Theory', 'eat', 'pizza', 1, 'East Village', 0.003, -0.002, false, V, 11, 27, 4.4, '🍕'],
  ['Coal Oven Co.', 'eat', 'pizza', 2, 'Williamsburg', -0.002, 0.002, false, V, 12, 24, 4.6, '🍕'],
  ['Hand Roll Bar 9', 'eat', 'sushi', 3, 'SoHo', 0.001, -0.001, false, ['gluten-free'], 17, 23, 4.7, '🍣'],
  ['Omakase Ten', 'eat', 'sushi', 4, 'Chelsea', -0.001, 0.002, false, ['gluten-free'], 18, 23, 4.8, '🍱'],
  ['Taqueria Luna', 'eat', 'mexican', 1, 'Lower East Side', 0.002, 0.001, false, ['gluten-free', 'vegetarian'], 11, 26, 4.5, '🌮'],
  ['Patio Cantina', 'eat', 'mexican', 2, 'Williamsburg', 0.001, 0.003, true, ['vegetarian'], 12, 24, 4.2, '🌯'],
  ['Halal Cart Deluxe', 'eat', 'middle-eastern', 1, 'Midtown', 0.001, 0.001, true, ['halal', 'gluten-free'], 10, 28, 4.3, '🥙'],
  ['Za\'atar House', 'eat', 'middle-eastern', 2, 'West Village', -0.002, -0.001, false, ['halal', 'vegetarian', 'vegan'], 11, 23, 4.6, '🧆'],
  ['Green Fork', 'eat', 'vegan', 2, 'East Village', 0.0, -0.003, false, VGF, 10, 22, 4.4, '🥗'],
  ['Kosher Deli Co.', 'eat', 'deli', 2, 'Midtown', -0.002, 0.002, false, ['kosher'], 8, 21, 4.3, '🥪'],
  ['Brunch Club', 'eat', 'brunch', 2, 'West Village', 0.002, 0.002, true, V, 9, 16, 4.5, '🥞'],
  ['Steak & Stone', 'eat', 'steakhouse', 4, 'FiDi', 0.001, 0.0, false, ['gluten-free'], 17, 23, 4.7, '🥩'],
  ['Noodle Lab', 'eat', 'ramen', 2, 'Midtown', 0.0, -0.002, false, [], 11, 24, 4.5, '🍥'],
  ['Dumpling Den', 'eat', 'chinese', 1, 'Lower East Side', -0.003, 0.0, false, V, 11, 23, 4.4, '🥟'],
  ['Trattoria Nonna', 'eat', 'italian', 3, 'SoHo', 0.002, 0.002, false, V, 17, 23, 4.6, '🍝'],
  ['Rooftop 21', 'drink', 'rooftop bar', 3, 'Midtown', 0.002, 0.001, true, [], 16, 26, 4.3, '🍸'],
  ['The Dive Inn', 'drink', 'dive bar', 1, 'East Village', -0.001, -0.001, false, [], 14, 28, 4.2, '🍺'],
  ['Hops Garden', 'drink', 'beer garden', 2, 'Williamsburg', -0.001, -0.002, true, [], 13, 25, 4.4, '🍻'],
  ['Velvet Room', 'drink', 'cocktail bar', 3, 'Lower East Side', 0.001, -0.002, false, [], 18, 27, 4.7, '🥃'],
  ['Wine & Vinyl', 'drink', 'wine bar', 2, 'West Village', 0.0, 0.003, false, [], 16, 25, 4.5, '🍷'],
  ['Bean Theory', 'drink', 'coffee', 1, 'SoHo', -0.001, 0.001, false, VG, 7, 18, 4.6, '☕'],
  ['Matcha Moon', 'drink', 'coffee', 1, 'Chelsea', 0.001, -0.002, false, VGF, 8, 19, 4.4, '🍵'],
  ['Trivia Tavern', 'drink', 'trivia', 2, 'Midtown', -0.001, -0.001, false, [], 17, 25, 4.3, '🧠'],
  ['Strike Zone Lanes', 'do', 'bowling', 2, 'Chelsea', 0.002, 0.0, false, [], 12, 26, 4.2, '🎳'],
  ['Locked In NYC', 'do', 'escape room', 3, 'Midtown', 0.0, 0.002, false, [], 11, 23, 4.7, '🔐'],
  ['Putt Club', 'do', 'mini golf', 2, 'Williamsburg', 0.003, 0.0, false, [], 12, 24, 4.4, '⛳'],
  ['Harbor Walk', 'do', 'park', 0, 'FiDi', -0.002, -0.002, true, VGF, 6, 22, 4.6, '🌳'],
  ['High Line Stroll', 'do', 'park', 0, 'Chelsea', -0.002, -0.002, true, VGF, 7, 22, 4.8, '🌿'],
  ['Modern Art Annex', 'do', 'museum', 2, 'Midtown', 0.003, -0.001, false, VGF, 10, 18, 4.7, '🖼️'],
  ['Basement Comedy Pop-Up', 'do', 'comedy', 2, 'West Village', -0.001, 0.0, false, [], 19, 26, 4.6, '🎤'],
  ['Karaoke Box 88', 'do', 'karaoke', 2, 'East Village', 0.002, 0.001, false, [], 18, 28, 4.3, '🎶'],
  ['Arcade Republic', 'do', 'arcade', 1, 'Lower East Side', 0.0, 0.003, false, [], 14, 26, 4.4, '🕹️'],
  ['Pottery Night', 'do', 'class', 3, 'SoHo', -0.002, 0.0, false, [], 18, 22, 4.6, '🏺'],
  ['Kayak the Hudson', 'do', 'outdoors', 0, 'West Village', 0.003, -0.004, true, VGF, 10, 18, 4.5, '🛶'],
  ['Indie Jazz Night', 'go', 'concert', 2, 'East Village', -0.003, 0.0, false, [], 20, 25, 4.6, '🎷'],
  ['Brooklyn Night Market', 'go', 'market', 1, 'Williamsburg', 0.0, 0.003, true, V, 17, 23, 4.5, '🏮'],
  ['Pickup Hoops @ Pier', 'go', 'sports', 0, 'Chelsea', 0.003, -0.003, true, VGF, 9, 21, 4.1, '🏀'],
  ['Open Mic Poetry', 'go', 'show', 1, 'Lower East Side', 0.002, -0.003, false, [], 19, 23, 4.3, '📜'],
  ['Rooftop Cinema', 'go', 'outdoor movie', 2, 'Midtown', -0.003, 0.0, true, [], 19, 24, 4.5, '🎬'],
];

// Streaming picks have no location, are free, and are always "open".
const watch = [
  ['The Last Lighthouse', 'thriller', '🌊'], ['Dinner for Six', 'comedy', '😂'],
  ['Starfall Station', 'sci-fi', '🚀'], ['Kitchen Wars', 'reality', '👨‍🍳'],
  ['Quiet Hours', 'drama', '🎭'], ['Ghosts of Mulberry St', 'horror', '👻'],
  ['Planet Under Ice', 'documentary', '🧊'], ['Love, Subtitled', 'romance', '💌'],
];

const places = rows.map((r, i) => {
  const [name, category, subtype, price, hood, dLat, dLng, outdoor, diet, open, close, rating, emoji] = r;
  const h = hoods[hood];
  return {
    id: `p${String(i + 1).padStart(2, '0')}`, name, category, subtype, price, hood,
    lat: +(h.lat + dLat).toFixed(5), lng: +(h.lng + dLng).toFixed(5),
    outdoor, diet, hours: { open, close }, rating, emoji,
  };
}).concat(watch.map(([name, subtype, emoji], i) => ({
  id: `w${i + 1}`, name, category: 'watch', subtype, price: 0, hood: 'Streaming',
  lat: null, lng: null, outdoor: false, diet: VGF.concat(['halal', 'kosher']),
  hours: null, rating: 4 + (i % 5) / 10, emoji,
})));

module.exports = { places, hoods };
