# Implementation Plan — Card-Move Animation + Video/Audio Calling

This plan is for implementing two features in the **Fish** card game. Read this whole
document before writing code. The app is a plain Node.js + Express + Socket.IO app with a
no-build vanilla-JS frontend.

## Project map (what to touch)

- `server.js` — Socket.IO server. In-memory `rooms[code]`. Emits `ask_result`, `room_update`, etc. Player object: `{ id: socket.id, name, icon, team, hand, connected }`. `publicRoom(room)` is what the client sees.
- `public/app.js` (~1450 lines) — all client logic. Key functions: `initSocket()` (socket handlers), `renderOvalPlayers()` (positions players around a circle), `showEventOverlay()` (the ask result popup), `buildCardFaceHTML()`.
- `public/index.html` — DOM. Game screen is `#tab-game` → `#left-panel` / `#game-table-area` (`#oval-players`, `#event-overlay`) / `#right-panel`.
- `public/style.css` — layout + animations. `#game-table-area` is `position:relative; overflow:hidden`. Player tiles are `.player-oval-tile` (absolutely positioned by `%`). Avatar is `.player-avatar-big` (68px). Existing `@keyframes card-flip` at line ~374 shows the animation idiom used.
- `public/cards.css` — card face styles.

Preserve the existing code style: no framework, no build step, functions attached to `window` implicitly (global), inline event handlers, template-string HTML. Match indentation (2 spaces) and the sectioned `// ===== NAME =====` comment banners.

---

# Feature 1 — Card-move animation when a player takes a card

### Goal
When a player asks for a card and the target **has it** (`hadCard === true`), show the card
visually fly from the target player's avatar to the asker's avatar, on every client's screen.
Today this only triggers a flip animation on the target's card fan (`stack-${targetId}`) inside
`showEventOverlay()` — replace/augment that with a real travelling card.

### Server
No change required. The existing `ask_result` payload already contains everything needed:
```js
io.to(code).emit('ask_result', {
  askerId, askerName, askerIcon,
  targetId, targetName, targetIcon,
  card, hadCard,
});
```
(See `server.js` `ask_card` handler.) Do **not** change turn/hand logic.

### Client — where the players are on screen
`renderOvalPlayers()` already builds a tile per player with `id`-derived DOM. To animate between
two avatars we need their on-screen rectangles. Add a stable hook so we can find them:

1. In `renderOvalPlayers()`, give each tile a locator attribute. On the outer `tile` element add:
   ```js
   tile.dataset.playerId = p.id;
   ```
   and on the avatar element add `id="avatar-${p.id}"` (the `.player-avatar-big` div). This gives a
   direct handle to the avatar center for both source and destination.

### Client — the flying-card animation
Add a new function `animateCardTransfer(fromPlayerId, toPlayerId, card)` in the
`// ===== EVENT OVERLAY =====` section of `app.js`:

1. Look up source and destination avatars: `document.getElementById('avatar-'+fromPlayerId)` and
   `...+toPlayerId`. If either is missing (player off-screen / not rendered), skip the animation
   gracefully (just return) — never throw.
2. Compute centers with `getBoundingClientRect()` for each, **relative to `#game-table-area`** (get
   its rect too and subtract), because the flying card should be appended inside
   `#game-table-area` (which is `position:relative; overflow:hidden`). If clipping by `overflow:hidden`
   is a problem, append to `document.body` instead and use viewport coordinates — pick body for
   simplicity and reliability.
3. Create a face-down card element (reuse the look of `.card-fan-card`, or a simple red card-back
   div). Give it `class="flying-card"`, `position:fixed`, set `left/top` to the source center,
   `transform: translate(-50%,-50%)`. Append to `document.body`.
4. Force reflow (`void el.offsetWidth`) then set the destination `left/top` and add a class that
   transitions `left, top, transform` over ~600ms with an easing curve (e.g.
   `cubic-bezier(.4,0,.2,1)`) plus a mid-flight scale-up then down and a slight rotation for
   character.
5. On `transitionend` (and a fallback `setTimeout` of ~800ms in case the event doesn't fire),
   remove the element. Optionally trigger a small "pop"/scale pulse on the destination avatar when
   it lands.
6. Optionally show the card face (rank+suit via `buildCardFaceHTML(card,'sm')`) instead of a card
   back — decide based on preference; a face-up card reads more clearly. Recommended: face-up.

### Client — wiring it in
In `showEventOverlay(...)` (the `ask_result` handler path), inside the Phase-2 timeout where
`hadCard` is true (currently adds `card-flip-anim` to `stack-${targetId}`), also call:
```js
animateCardTransfer(targetId, askerId, card);
```
Card flows **from target → to asker** (the asker successfully took it). Keep or remove the existing
fan-flip; keeping a brief flip on the target fan as the card "lifts off" looks good. Timing: the
existing overlay reveals "YES!" at 1400ms — start the fly at that moment so it matches the reveal.

Guard against double-firing if `showEventOverlay` returns early (e.g. when `state.scoreOverlayOpen`).
In that early-return case, still call `animateCardTransfer` so the motion plays even if the text
overlay is suppressed — or intentionally skip; choose to still animate (nicer). Put the
`animateCardTransfer` call before the `if (state.scoreOverlayOpen) return;` guard so it always runs.

### CSS (add to `style.css`)
```css
/* ===== FLYING CARD (card transfer animation) ===== */
.flying-card {
  position: fixed;
  z-index: 400;              /* above overlays but pointer-events:none */
  pointer-events: none;
  transform: translate(-50%, -50%) rotate(0deg);
  transition: left .6s cubic-bezier(.4,0,.2,1),
              top  .6s cubic-bezier(.4,0,.2,1),
              transform .6s cubic-bezier(.4,0,.2,1);
  will-change: left, top, transform;
}
.flying-card.mid { transform: translate(-50%,-50%) scale(1.25) rotate(8deg); }
```
(If you drive scale purely in JS with a keyframe instead, that's fine too — but a CSS transition on
`left/top` is the simplest robust approach for arbitrary source→dest coordinates.)

### Acceptance
- With 2 clients: on a successful ask, both clients see a card fly from the target's avatar to the
  asker's avatar. On a failed ask (No), no card flies.
- Works regardless of which client is asker/target/observer (positions are per-client because seating
  is rotated so "you" are always at the bottom).
- No console errors when a player involved is disconnected/not rendered.

---

# Feature 2 — Video + audio calling (WebRTC) with directional audio

### Overview
Add real-time peer-to-peer video/audio between everyone in a room using **WebRTC**, with
**Socket.IO as the signaling channel** (offer/answer/ICE relay). Topology: **full mesh** (each
client connects directly to every other client). This is appropriate for the game's size (2–10
players). Live video **replaces the player's avatar icon** in the oval, rendered at **~2× the current
avatar size**. Audio is **spatialized** (panned left/right) according to where that player sits on
the current client's screen.

> Note: full mesh with up to 10 players = up to 9 peer connections per client. That is acceptable but
> heavy; keep video resolution modest (e.g. 240p) and allow users to turn their camera/mic off. Do not
> attempt an SFU — out of scope.

## 2a. Signaling — `server.js`

Add signaling relay handlers inside `io.on('connection', socket => { ... })`. These just forward
messages between sockets in the same room; the server never touches media.

```js
// --- WebRTC signaling relay (media is peer-to-peer; server only relays) ---
socket.on('rtc_signal', ({ toId, data }) => {
  const { code } = socket.data || {};
  if (!code) return;
  const room = rooms[code];
  if (!room) return;
  // Only relay to a socket that is actually in this room
  const target = room.players.find(p => p.id === toId);
  if (!target) return;
  io.to(toId).emit('rtc_signal', { fromId: socket.id, data });
});

// Announce media availability so peers can (re)initiate connections
socket.on('rtc_ready', () => {
  const { code } = socket.data || {};
  if (!code) return;
  socket.to(code).emit('rtc_peer_ready', { id: socket.id });
});
```

- `data` is an opaque signaling payload: `{ type: 'offer'|'answer', sdp }` or `{ type: 'ice', candidate }`.
- Reuse `socket.id` as the peer id — it already matches `player.id` everywhere in the client.
- **Reconnection caveat:** when a player disconnects/rejoins, their `player.id` changes (see the
  rejoin logic in `join_room`). RTC peer connections are keyed by socket id, so a rejoin naturally
  looks like a new peer — the client's `room_update` diff (below) will tear down the old peer id and
  set up the new one. No special server work needed beyond what's above.

No other server changes. Media never flows through the server, so bandwidth stays low.

## 2b. Client media module — new file `public/rtc.js`

Create a new file and include it in `index.html` **after** `app.js`:
```html
<script src="app.js"></script>
<script src="rtc.js"></script>
```
Keep all WebRTC logic in this module to avoid bloating `app.js`. Expose a small API on `window`
(e.g. `window.RTC`) that `app.js` can call, and let `rtc.js` read `state.room` / `socket` (both are
globals defined in `app.js`).

### Responsibilities of `rtc.js`

**State**
```js
const peers = {};      // peerId -> { pc: RTCPeerConnection, stream: MediaStream, audioNodes... }
let localStream = null;
let mediaEnabled = false;
let camOn = true, micOn = true;
```

**Config**
```js
const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};
```
STUN alone works on most home/LAN networks. If cross-NAT reliability matters later, a TURN server is
needed — leave a `// TODO: add TURN for restrictive NATs` comment. Do not hardcode a paid TURN here.

**Getting local media** — `async function startMedia()`:
1. `navigator.mediaDevices.getUserMedia({ video: { width:320, height:240 }, audio: true })`.
2. Store as `localStream`, set `mediaEnabled = true`.
3. Render the local preview into the current player's avatar slot (see 2c) — the local video should
   be **muted** (`video.muted = true`) to avoid echo.
4. `socket.emit('rtc_ready')` to tell existing peers to initiate offers, and also proactively create
   offers to everyone already in `state.room.players` (except self). Handle the "glare" problem with a
   deterministic initiator rule: **the peer with the lexicographically smaller socket id creates the
   offer.** This avoids both sides offering simultaneously.
5. Wrap in try/catch; if the user denies permission, set `mediaEnabled=false` and fall back to the
   static avatar image everywhere (feature must degrade gracefully — the game still works with no
   camera).

**Creating a peer connection** — `function createPeer(peerId, isInitiator)`:
1. `const pc = new RTCPeerConnection(RTC_CONFIG)`.
2. Add local tracks: `localStream.getTracks().forEach(t => pc.addTrack(t, localStream))`.
3. `pc.onicecandidate = e => { if (e.candidate) socket.emit('rtc_signal', { toId: peerId, data: { type:'ice', candidate: e.candidate } }); }`.
4. `pc.ontrack = e => { peers[peerId].stream = e.streams[0]; attachPeerMedia(peerId, e.streams[0]); }`.
5. `pc.onconnectionstatechange` — on `failed`/`closed`/`disconnected`, clean up (`closePeer(peerId)`).
6. Store `peers[peerId] = { pc }`.
7. If `isInitiator`: `createOffer` → `setLocalDescription` → emit `rtc_signal` with the offer.

**Handling incoming signals** — `socket.on('rtc_signal', async ({ fromId, data }) => { ... })`:
- If we don't have a peer for `fromId` yet, create one with `isInitiator=false`.
- `offer`: `setRemoteDescription(offer)` → `createAnswer` → `setLocalDescription` → emit answer.
- `answer`: `setRemoteDescription(answer)`.
- `ice`: `pc.addIceCandidate(candidate)` (guard with try/catch; candidates can arrive before remote
  desc — queue them or ignore the benign error).

**Peer lifecycle tied to room membership**
- Listen for the app's existing `room_update` to reconcile peers. Simplest hook: in `app.js`'s
  `socket.on('room_update', ...)`, after `state.room = room`, call `window.RTC?.syncPeers?.()`.
  `syncPeers()` compares `state.room.players` ids against `Object.keys(peers)`:
  - For each current player id not in `peers` and not self: if media is on, create a peer (respect the
    smaller-id-initiates rule).
  - For each peer id no longer in the room: `closePeer(id)`.
- `socket.on('rtc_peer_ready', ({ id }) => { if mediaEnabled && id!==self create/offer as needed })`.
- `closePeer(id)`: stop the peer's audio graph, `pc.close()`, delete `peers[id]`, and re-render that
  player's avatar back to the static icon.

**Cleanup**
- On `exitGame()` / `goHome()` in `app.js`, call `window.RTC?.stopAll?.()` which closes all peers,
  stops `localStream` tracks, and resets state. Add that call to the existing `goHome()`.

## 2c. Rendering video into the oval avatar (replace icon, ~2× size)

The avatar is `.player-avatar-big` (68px, inside `.player-avatar-wrap` inside `.player-fan-root`),
built in `renderOvalPlayers()`. We must:

1. **Make the avatar able to hold a `<video>`.** In `renderOvalPlayers()`, when building each tile,
   give the avatar a stable id (already added in Feature 1: `id="avatar-${p.id}"`). Keep the
   `<img>`/emoji as the default content.

2. **Do not let `renderOvalPlayers()` destroy live video.** `renderOvalPlayers()` does
   `container.innerHTML = ''` and rebuilds every tile on every render — this would wipe `<video>`
   elements and their `srcObject`. Two options; pick **Option A**:
   - **Option A (recommended):** After each `renderOvalPlayers()` run, call
     `window.RTC?.reattachAllVideos?.()`, which for every peer (and local) re-inserts its `<video>`
     into the freshly-rebuilt `#avatar-${id}` and re-assigns `srcObject` (assigning an existing
     `MediaStream` to a new element is cheap and does not restart the stream). Also handle the "video
     enlarges the avatar" sizing here by toggling a class on the tile.
   - Option B (more invasive): make `renderOvalPlayers` diff instead of `innerHTML=''`. Skip — too big
     a refactor.

3. **Enlarge the avatar when video is active (~2×).** Add a CSS class, e.g. `.has-video`, applied to
   the `.player-avatar-wrap` or `.player-avatar-big` when a live stream is attached:
   ```css
   .player-avatar-big.has-video { width: 136px; height: 136px; }
   .player-avatar-big.has-video video {
     width: 100%; height: 100%; object-fit: cover; border-radius: 50%;
     transform: scaleX(-1);   /* mirror local + optional for remote; mirror local only if preferred */
   }
   ```
   - 136px = 2 × 68px. Because tiles are centered via `transform: translate(-50%,-50%)`, enlarging is
     safe positionally, but with up to 10 seats on a circle the bigger avatars may overlap. Mitigate:
     only enlarge to ~2× for ≤6 players; for larger tables cap at ~1.5× (e.g. `.has-video.compact`).
     Read `state.room.players.length` to decide. State this tradeoff in a comment.
   - Mirror **only the local** self-view (`scaleX(-1)`), not remote peers (remote video should look
     natural to others). Give local video an extra class to control this.

4. **`attachPeerMedia(peerId, stream)`** (in `rtc.js`):
   - Find `#avatar-${peerId}`. If absent (not rendered yet), store the stream and let
     `reattachAllVideos()` pick it up on the next render.
   - Create/reuse a `<video autoplay playsinline>` element, `video.srcObject = stream`, append into
     the avatar, hide the `<img>`/emoji, add `.has-video`.
   - Remote video: **not** muted (we want their audio) — but route audio through the Web Audio graph
     for panning (see 2d), and set `video.muted = true` so the `<video>` element itself does not also
     play the audio (double audio / no panning otherwise). Play audio only through the panned
     Web-Audio path.
   - Local self-view: `video.muted = true`, add mirror class, **do not** create an audio panner for
     yourself.

## 2d. Directional (stereo) audio based on screen position

Use the Web Audio API to pan each remote peer's audio left/right according to their horizontal
position in the oval on **this** client's screen. `renderOvalPlayers()` already computes each seat's
angle and `xPct` (0–100, where 50 is center). Reuse that.

1. **Reuse the existing AudioContext.** `app.js` has `getAudioCtx()` (used for sound effects). Export
   or reuse it from `rtc.js` (call `window.getAudioCtx?.()`; if you need it accessible, ensure
   `getAudioCtx` is a global — it already is, defined at top of `app.js`). Do not create a second
   `AudioContext`.

2. **Per-peer audio graph** — when attaching a remote stream:
   ```js
   const ctx = getAudioCtx();
   const src = ctx.createMediaStreamSource(stream);
   const panner = ctx.createStereoPanner();   // pan in [-1, 1]
   src.connect(panner).connect(ctx.destination);
   peers[peerId].audioNodes = { src, panner };
   ```
   Because the `<video>` element is muted, this is the only audio path → panning actually applies.

   > Gotcha: some browsers won't emit audio from a `MediaStreamSource` unless the stream is also
   > attached to a (muted) media element. You already attach the stream to a muted `<video>`, which
   > satisfies this in Chrome. Keep the muted `<video>` even for audio-only cases.

3. **Compute pan from seat position.** Add `updatePanning()` in `rtc.js`, called at the end of
   `renderOvalPlayers()` (via `window.RTC?.updatePanning?.()`), since seat positions change when the
   seating rotates. For each peer, get its seat's horizontal fraction. Easiest: read the peer tile's
   center relative to `#game-table-area` width:
   ```js
   const area = document.getElementById('game-table-area').getBoundingClientRect();
   const av = document.getElementById('avatar-'+peerId);
   if (!av) continue;
   const c = av.getBoundingClientRect();
   const cx = (c.left + c.width/2 - area.left) / area.width; // 0..1
   const pan = Math.max(-1, Math.min(1, (cx - 0.5) * 2 * 0.8)); // 0.8 = soften extremes
   peers[peerId].audioNodes?.panner.setTargetAtTime(pan, ctx.currentTime, 0.05);
   ```
   Using the DOM rect keeps pan in sync with wherever the avatar actually ends up. Optionally also
   scale gain by vertical distance for a subtle depth effect (optional; not required).

4. Update panning whenever the layout changes: at the end of `renderOvalPlayers()` and on window
   `resize`.

## 2e. UI controls

Add camera/mic toggles so the feature is opt-in and controllable. Two small buttons in the `#nav`
bar (next to the existing `🔊` sound toggle in `index.html`), or a floating control in
`#game-table-area`. Minimum:

- **Join call / Enable camera** button → calls `window.RTC.startMedia()`. Media should **not**
  auto-start (browsers block autoplay + it's polite to ask). Show it during the `playing` phase.
- **Toggle camera** (`camOn`): `localStream.getVideoTracks().forEach(t => t.enabled = !t.enabled)`;
  when off, show the static avatar again for the local tile.
- **Toggle mic** (`micOn`): `localStream.getAudioTracks().forEach(t => t.enabled = !t.enabled)`.
- Reflect state with emoji (🎥 / 🚫, 🎙️ / 🔇) like the existing sound toggle does.

Wire buttons to `window.RTC` methods. Keep styling consistent with `.nav-item`.

## 2f. Ordering / gotchas checklist

- Include `rtc.js` after `app.js` in `index.html`.
- `getUserMedia` and full WebRTC require a **secure context**: works on `localhost`, but on a LAN IP
  (e.g. testing across phones) browsers require **HTTPS**. Note this in a comment; for real multi-device
  testing the server must be served over HTTPS (or via a tunnel like ngrok). Document in README.
- Autoplay: set `autoplay playsinline` on every `<video>`; resume the AudioContext on a user gesture
  (the "Join call" button click is a valid gesture — call `getAudioCtx()` there).
- Echo: local self-view video **must** be muted; remote `<video>` elements muted with audio routed
  via Web Audio.
- Glare: deterministic initiator (smaller socket id offers).
- Teardown: close peers on `room_update` removal, on `disconnect`, and on `goHome()`.
- Do not break the game if a user has no camera/denies permission — everything degrades to the
  current static-avatar behavior.

## 2g. Acceptance
- Two browsers in one game, both click "Join call": each sees the other's live video in place of the
  avatar, roughly double size. Audio is panned to match the other player's on-screen side.
- Toggling camera/mic updates both local view and remote peers.
- A third player joining mid-game establishes video with both existing players (mesh).
- A player leaving/refreshing tears down their video on others' screens without errors.
- Feature 1's card animation still plays over/around the now-larger avatars.

---

# Suggested implementation order
1. Feature 1 (self-contained, low risk): add avatar ids + `animateCardTransfer` + CSS, wire into
   `showEventOverlay`. Test with 2 clients.
2. Feature 2 signaling relay in `server.js`.
3. `rtc.js`: local media + mesh peer connections + basic remote `<video>` (no sizing/panning yet).
4. Video-into-avatar rendering + `reattachAllVideos` + `.has-video` sizing.
5. Directional audio (`updatePanning`).
6. UI toggles + teardown + graceful-degradation testing.

Test each stage with two browser windows/profiles on `localhost` before moving on.
