// ── AVATAR CONFIG ─────────────────────────────────────────────────────────────
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

function toDataUrl(svg) {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

function fallback() {
  console.warn('[avatars] Using plain CDN fallback (no custom options)');
  window.DICEBEAR_AVATARS = SEEDS.map(seed => ({
    seed,
    url: `https://api.dicebear.com/9.x/miniavs/svg?seed=${seed}`
  }));
}

try {
  // esm.sh handles npm → ESM properly and resolves the correct version
  console.log('[avatars] Loading @dicebear/core from esm.sh...');
  const core = await import('https://esm.sh/@dicebear/core');
  console.log('[avatars] Core exports:', Object.keys(core).join(', '));

  const { Style, Avatar, createAvatar } = core;

  if (Style && Avatar) {
    // v10 API
    console.log('[avatars] Using v10 API (Style + Avatar)');
    const res = await fetch('https://esm.sh/@dicebear/styles/miniavs.min.json');
    if (!res.ok) throw new Error(`miniavs.min.json fetch failed: ${res.status}`);
    const definition = await res.json();
    const style = new Style(definition);
    window.DICEBEAR_AVATARS = SEEDS.map(seed => {
      const svg = new Avatar(style, { ...OPTIONS, seed }).toString();
      return { seed, url: toDataUrl(svg) };
    });
    console.log('[avatars] ✓ Generated', window.DICEBEAR_AVATARS.length, 'avatars with full custom options');

  } else if (createAvatar) {
    // v9 API
    console.log('[avatars] Using v9 API (createAvatar)');
    const { default: miniavs } = await import('https://esm.sh/@dicebear/miniavs');
    window.DICEBEAR_AVATARS = SEEDS.map(seed => {
      const svg = createAvatar(miniavs, { ...OPTIONS, seed }).toString();
      return { seed, url: toDataUrl(svg) };
    });
    console.log('[avatars] ✓ Generated', window.DICEBEAR_AVATARS.length, 'avatars (v9, some options may differ)');

  } else {
    throw new Error('Neither Style/Avatar nor createAvatar found in core module');
  }

} catch (err) {
  console.error('[avatars] Failed:', err.message);
  fallback();
}

document.dispatchEvent(new CustomEvent('dicebear-ready'));
