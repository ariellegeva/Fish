// ===================== WEBRTC VIDEO/AUDIO =====================
// Peer-to-peer mesh via Socket.IO signaling. Requires secure context (HTTPS or localhost).
// TODO: add TURN for restrictive NATs — STUN alone may fail across some networks.

const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

const peers = {};       // peerId -> { pc, stream, audioNodes, pendingCandidates, videoEl }
let localStream = null;
let mediaEnabled = false;
let camOn = true;
let micOn = true;
let pendingLocalStream = null; // stream waiting for avatar DOM after render

function selfId() {
  return socket?.id || state?.myId;
}

function shouldInitiate(peerId) {
  const me = selfId();
  return me && peerId && me < peerId;
}

function videoSizeClass() {
  const n = state?.room?.players?.length || 0;
  // 2× avatar for ≤6 seats; ~1.5× when crowded to reduce overlap
  return n > 6 ? 'has-video compact' : 'has-video';
}

function updateRtcButtons() {
  const join = document.getElementById('nav-rtc-join');
  const cam = document.getElementById('nav-rtc-cam');
  const mic = document.getElementById('nav-rtc-mic');
  const playing = state?.room?.phase === 'playing';
  if (join) join.style.display = playing ? '' : 'none';
  if (cam) cam.style.display = mediaEnabled && playing ? '' : 'none';
  if (mic) mic.style.display = mediaEnabled && playing ? '' : 'none';
  if (join) join.textContent = mediaEnabled ? '📞' : '📞 Join call';
  if (cam) cam.textContent = camOn ? '🎥' : '🚫';
  if (mic) mic.textContent = micOn ? '🎙️' : '🔇';
}

function stopAudioNodes(peerId) {
  const entry = peers[peerId];
  if (!entry?.audioNodes) return;
  try {
    entry.audioNodes.src.disconnect();
    entry.audioNodes.panner.disconnect();
  } catch (e) { /* already disconnected */ }
  entry.audioNodes = null;
}

function restoreStaticAvatar(playerId) {
  const av = document.getElementById('avatar-' + playerId);
  if (!av) return;
  av.querySelector('video')?.remove();
  av.classList.remove('has-video', 'compact');
  const fb = av.querySelector('.avatar-fallback');
  if (fb) fb.style.display = '';
}

function attachStreamToAvatar(playerId, stream, isLocal) {
  const av = document.getElementById('avatar-' + playerId);
  if (!av) {
    if (isLocal) pendingLocalStream = stream;
    else if (peers[playerId]) peers[playerId].stream = stream;
    return null;
  }

  const hasLiveVideo = stream.getVideoTracks().some(t => t.enabled && t.readyState === 'live');
  const showVideo = isLocal ? (camOn && hasLiveVideo) : hasLiveVideo;

  let video = av.querySelector('video');
  if (!video) {
    video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    av.appendChild(video);
  }

  video.srcObject = stream;
  video.muted = true;
  if (isLocal) video.classList.add('mirror');
  else video.classList.remove('mirror');

  av.classList.remove('has-video', 'compact');
  if (showVideo) av.classList.add(...videoSizeClass().split(' '));

  const fb = av.querySelector('.avatar-fallback');
  if (fb) fb.style.display = showVideo ? 'none' : '';

  if (isLocal) pendingLocalStream = null;
  if (showVideo) video.play().catch(() => {});
  return video;
}

function setupRemoteAudio(peerId, stream) {
  if (peerId === selfId()) return;
  const ctx = getAudioCtx?.();
  if (!ctx || !stream.getAudioTracks().length) return;

  stopAudioNodes(peerId);
  const src = ctx.createMediaStreamSource(stream);
  const panner = ctx.createStereoPanner();
  src.connect(panner).connect(ctx.destination);
  if (!peers[peerId]) peers[peerId] = {};
  peers[peerId].audioNodes = { src, panner };
  updatePanning();
}

function attachPeerMedia(peerId, stream) {
  if (!stream) return;
  if (!peers[peerId]) peers[peerId] = {};
  peers[peerId].stream = stream;
  peers[peerId].videoEl = attachStreamToAvatar(peerId, stream, peerId === selfId());
  setupRemoteAudio(peerId, stream);
}

function closePeer(peerId) {
  const entry = peers[peerId];
  if (!entry) return;
  stopAudioNodes(peerId);
  try { entry.pc?.close(); } catch (e) { /* ignore */ }
  delete peers[peerId];
  restoreStaticAvatar(peerId);
}

async function flushPendingCandidates(peerId) {
  const entry = peers[peerId];
  if (!entry?.pc?.remoteDescription || !entry.pendingCandidates?.length) return;
  const pending = entry.pendingCandidates;
  entry.pendingCandidates = [];
  for (const c of pending) {
    try { await entry.pc.addIceCandidate(c); } catch (e) { /* benign ordering */ }
  }
}

async function createPeer(peerId, isInitiator) {
  if (peerId === selfId() || peers[peerId]?.pc) return;
  // Only the initiator needs local media; answerers can receive without sharing
  if (isInitiator && !localStream) return;

  const pc = new RTCPeerConnection(RTC_CONFIG);
  peers[peerId] = { ...(peers[peerId] || {}), pc, pendingCandidates: [] };

  if (localStream) {
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('rtc_signal', { toId: peerId, data: { type: 'ice', candidate: e.candidate } });
    }
  };

  pc.ontrack = (e) => {
    const stream = e.streams[0];
    if (stream) {
      getAudioCtx?.(); // best-effort for remote audio playback
      attachPeerMedia(peerId, stream);
    }
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'failed' || s === 'closed' || s === 'disconnected') closePeer(peerId);
  };

  if (isInitiator) {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('rtc_signal', { toId: peerId, data: { type: 'offer', sdp: offer } });
    } catch (e) {
      console.warn('RTC offer failed', e);
      closePeer(peerId);
    }
  }
}

async function handleSignal({ fromId, data }) {
  if (!data || fromId === selfId()) return;

  if (!peers[fromId]?.pc) {
    await createPeer(fromId, false);
  }
  const entry = peers[fromId];
  if (!entry?.pc) return;

  try {
    if (data.type === 'offer') {
      await entry.pc.setRemoteDescription(data.sdp);
      await flushPendingCandidates(fromId);
      const answer = await entry.pc.createAnswer();
      await entry.pc.setLocalDescription(answer);
      socket.emit('rtc_signal', { toId: fromId, data: { type: 'answer', sdp: answer } });
    } else if (data.type === 'answer') {
      await entry.pc.setRemoteDescription(data.sdp);
      await flushPendingCandidates(fromId);
    } else if (data.type === 'ice' && data.candidate) {
      if (entry.pc.remoteDescription) {
        await entry.pc.addIceCandidate(data.candidate);
      } else {
        entry.pendingCandidates = entry.pendingCandidates || [];
        entry.pendingCandidates.push(data.candidate);
      }
    }
  } catch (e) {
    console.warn('RTC signal error', e);
  }
}

function connectToPeer(peerId, forceInitiate) {
  if (!mediaEnabled || !localStream || peerId === selfId()) return;
  if (peers[peerId]?.pc) return;
  createPeer(peerId, forceInitiate ?? shouldInitiate(peerId));
}

function syncPeers() {
  if (!mediaEnabled || !localStream || !state?.room) return;
  const ids = new Set(state.room.players.map(p => p.id));
  ids.delete(selfId());

  for (const id of Object.keys(peers)) {
    if (!ids.has(id)) closePeer(id);
  }
  for (const id of ids) connectToPeer(id);
}

function reattachAllVideos() {
  if (localStream && mediaEnabled) {
    attachStreamToAvatar(selfId(), localStream, true);
  } else if (pendingLocalStream) {
    attachStreamToAvatar(selfId(), pendingLocalStream, true);
  }
  for (const [peerId, entry] of Object.entries(peers)) {
    if (entry.stream) attachPeerMedia(peerId, entry.stream);
  }
}

function updatePanning() {
  const ctx = getAudioCtx?.();
  const area = document.getElementById('game-table-area');
  if (!ctx || !area) return;

  for (const [peerId, entry] of Object.entries(peers)) {
    if (!entry.audioNodes?.panner) continue;
    const av = document.getElementById('avatar-' + peerId);
    if (!av) continue;
    const areaRect = area.getBoundingClientRect();
    const c = av.getBoundingClientRect();
    const cx = (c.left + c.width / 2 - areaRect.left) / areaRect.width;
    const pan = Math.max(-1, Math.min(1, (cx - 0.5) * 2 * 0.8));
    entry.audioNodes.panner.pan.setTargetAtTime(pan, ctx.currentTime, 0.05);
  }
}

async function upgradePeerWithLocalMedia(peerId) {
  const entry = peers[peerId];
  if (!entry?.pc || !localStream) return;
  localStream.getTracks().forEach(t => {
    const hasKind = entry.pc.getSenders().some(s => s.track?.kind === t.kind);
    if (!hasKind) entry.pc.addTrack(t, localStream);
  });
  try {
    const offer = await entry.pc.createOffer();
    await entry.pc.setLocalDescription(offer);
    socket.emit('rtc_signal', { toId: peerId, data: { type: 'offer', sdp: offer } });
  } catch (e) {
    console.warn('RTC renegotiation failed', e);
  }
}

async function startMedia() {
  if (mediaEnabled) return;
  getAudioCtx?.(); // user gesture — resume AudioContext

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 320, height: 240 },
      audio: true,
    });
  } catch (e) {
    console.warn('getUserMedia denied or unavailable', e);
    mediaEnabled = false;
    updateRtcButtons();
    return;
  }

  mediaEnabled = true;
  camOn = true;
  micOn = true;
  attachStreamToAvatar(selfId(), localStream, true);
  socket.emit('rtc_ready');

  if (state?.room?.players) {
    for (const p of state.room.players) {
      if (p.id === selfId()) continue;
      if (peers[p.id]?.pc) await upgradePeerWithLocalMedia(p.id);
      else connectToPeer(p.id, true);
    }
  }
  updateRtcButtons();
}

function toggleCam() {
  if (!localStream) return;
  camOn = !camOn;
  localStream.getVideoTracks().forEach(t => { t.enabled = camOn; });
  attachStreamToAvatar(selfId(), localStream, true);
  updateRtcButtons();
}

function toggleMic() {
  if (!localStream) return;
  micOn = !micOn;
  localStream.getAudioTracks().forEach(t => { t.enabled = micOn; });
  updateRtcButtons();
}

function stopAll() {
  for (const id of Object.keys({ ...peers })) closePeer(id);
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  pendingLocalStream = null;
  mediaEnabled = false;
  camOn = true;
  micOn = true;
  restoreStaticAvatar(selfId());
  updateRtcButtons();
}

function onPeerReady({ id }) {
  if (mediaEnabled && id !== selfId()) connectToPeer(id);
}

function initRtcSocket() {
  if (!socket || socket._rtcBound) return;
  socket._rtcBound = true;
  socket.on('rtc_signal', handleSignal);
  socket.on('rtc_peer_ready', onPeerReady);
}

// Poll until app.js has created the socket
(function waitForSocket() {
  if (typeof socket !== 'undefined' && socket) {
    initRtcSocket();
  } else {
    setTimeout(waitForSocket, 50);
  }
})();

window.addEventListener('resize', () => updatePanning());

window.RTC = {
  startMedia,
  toggleCam,
  toggleMic,
  syncPeers,
  reattachAllVideos,
  updatePanning,
  stopAll,
  updateNavControls: updateRtcButtons,
};
