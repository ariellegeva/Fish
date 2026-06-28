// ── AVATAR CONFIG ─────────────────────────────────────────────────────────────
// Edit OPTIONS to match your Dicebear playground settings.
// Edit SEEDS to change which avatars appear in the picker.
// ──────────────────────────────────────────────────────────────────────────────

const OPTIONS = {
  bodyColor:          ['e05a33','ff4dd8','52a0bc','b07be5','ff2424','812828'],
  bodyColorFill:      ['linear'],
  bodyColorFillStops: 2,
  bodyColorAngle:     3,
  mustacheProbability: 30,
  hairColor:  ['1b0b47','47280b','ad3a20','4d70ff','ff1aab','fff3a8'],
  skinColor:  ['836055','f5d0c5','ffcb7e','fce7fd','b25757','610000','fbefef','cfd3f7'],
  blushProbability:   40,
  glassesProbability: 10,
  hairVariant:     { balndess:1, classic01:2, classic02:2, curly:3, elvis:2, long:5, ponyTail:5, slaughter:2, stylish:2 },
  headVariant:     { normal:1, thin:3, wide:1 },
  mouthVariant:    { default:3, missingTooth:1 },
  mustacheVariant: { freddy:3, horshoe:2, pencilThin:1, pencilThinBeard:1 },
};

const SEEDS = [
  'n','Panda','Foxc','m','p','Cat','dragonk','c',
  'fff','Lionl','nor','peet','spar','tell','Wolfy','Zebra',
  'Monkey','Penguin','Koala','Dolphin'
];

// ──────────────────────────────────────────────────────────────────────────────
// Load Dicebear from CDN and generate all avatars before DOMContentLoaded
// ──────────────────────────────────────────────────────────────────────────────
try {
  const { Style, Avatar } = await import('https://cdn.jsdelivr.net/npm/@dicebear/core/+esm');

  const res = await fetch('https://cdn.jsdelivr.net/npm/@dicebear/styles/miniavs.min.json');
  const definition = await res.json();
  const style = new Style(definition);

  window.DICEBEAR_AVATARS = SEEDS.map(seed => {
    const svg = new Avatar(style, { ...OPTIONS, seed }).toString();
    return { seed, url: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) };
  });
} catch (err) {
  console.warn('Dicebear CDN failed, falling back to URL avatars:', err);
  // Fallback: use plain CDN URLs (no custom options)
  window.DICEBEAR_AVATARS = SEEDS.map(seed => ({
    seed,
    url: `https://api.dicebear.com/9.x/miniavs/svg?seed=${seed}`
  }));
}
