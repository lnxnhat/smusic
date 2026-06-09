/* ============================================================
   CONFIG - LINK TỚI GOOGLE APPS SCRIPT
   ============================================================ */
const WEB_APP_URL = "https://script.google.com/macros/s/AKfycbwUgRFtf6SdwgFQ1RP6QpIxzxzshCDT0E_jypErRxebcqFIrmDwqdUQy9S87oIVWJWE9Q/exec";

const STORE_KEY  = 'smusic_supabase_storage';
const EQ_FREQS   = [60, 150, 400, 1000, 2400, 15000];
const EQ_TYPES   = ['lowshelf','peaking','peaking','peaking','peaking','highshelf'];
const SONG_STARTS = { 'leave me alone': 22, 'broken strings': 30 };

let S = { playlist: [], queue: [], idx: 0, random: true, volume: 100, counts: {}, eq: [0,0,0,0,0,0], spectrum: true, savedTime: 0 };

const aud = document.getElementById('aud');
const cacheAud = document.getElementById('cache-aud');
let actx = null, analyser = null, gainNode = null;
const eqFilters = [];
let audReady = false;

let countAdded = false, isNextPress = false, totalSeekMs = 0, dragging = false, seekSnapStart = 0;
let fadeInterval = null; 
let cacheManifest = new Set(); // Bộ nhớ lưu trữ xem file nào đã tải offline

async function init() {
  loadStateFromBrowser();
  hookProgress();
  hookVolume();
  hookTabs();
  hookGestures();
  await refreshCacheManifest(); // Quét bộ nhớ máy
  await fetchFromGoogle();
  applyUI();
  hideLoader();

  setInterval(saveStateToBrowser, 1000);
  setInterval(tickUI, 200);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && actx && actx.state === 'suspended') actx.resume();
  });
}

function loadStateFromBrowser() {
  try { const s = localStorage.getItem(STORE_KEY); if (s) Object.assign(S, JSON.parse(s)); } catch(e) {}
}

function saveStateToBrowser() {
  try {
    if (aud.currentTime > 0) S.savedTime = aud.currentTime;
    localStorage.setItem(STORE_KEY, JSON.stringify({
      queue: S.queue, idx: S.idx, random: S.random, volume: S.volume, eq: S.eq, spectrum: S.spectrum, savedTime: S.savedTime
    }));
  } catch(e) {}
}

// --- HỆ THỐNG CACHE & DOWNLOAD OFFLINE ---
async function refreshCacheManifest() {
  try {
    const cache = await caches.open('smusic-cache');
    const keys = await cache.keys();
    cacheManifest = new Set(keys.map(req => req.url));
  } catch(e) { console.warn("Lỗi kiểm tra Cache", e); }
}

async function getAudioSrc(url) {
  try {
    if (cacheManifest.has(url)) {
      const cache = await caches.open('smusic-cache');
      const res = await cache.match(url);
      if (res) return URL.createObjectURL(await res.blob()); // Trả về link nội bộ
    }
  } catch (e) {}
  return url; // Nếu chưa tải thì trả về link gốc
}

function downloadSong(url, songId) {
  const btn = document.getElementById(`dl-${songId}`);
  if (btn) btn.innerText = "[ Đang tải... ]";

  const xhr = new XMLHttpRequest();
  xhr.open('GET', url, true);
  xhr.responseType = 'blob';

  xhr.onprogress = (e) => {
    if (e.lengthComputable && btn) {
      const percent = Math.round((e.loaded / e.total) * 100);
      btn.innerText = `[ ${percent}% ]`;
    }
  };

  xhr.onload = async () => {
    if (xhr.status === 200) {
      const cache = await caches.open('smusic-cache');
      await cache.put(url, new Response(xhr.response));
      cacheManifest.add(url); // Cập nhật vào hệ thống
      if (btn) {
        btn.innerText = "[ Đã lưu ]";
        btn.disabled = true;
      }
    }
  };
  xhr.send();
}

async function fetchFromGoogle() {
  setStatus('Đang tải dữ liệu...');
  try {
    const res = await fetch(WEB_APP_URL);
    const data = await res.json();
    const validSongs = data.songs.filter(s => s.name && s.url);
    if (validSongs.length === 0) throw new Error('Không tìm thấy link nhạc!');

    S.playlist = validSongs;
    S.counts = data.counts || {};
    setStatus(`Đã đồng bộ ${S.playlist.length} bài`);
    buildInitialQueue();
  } catch(err) {
    setStatus('Lỗi: ' + err.message);
  }
}

function buildInitialQueue() {
  const pl = S.playlist.map(s => s.name);
  if (S.queue.length > 0) {
    const valid = S.queue.filter(n => pl.includes(n));
    if (valid.length) {
      S.queue = valid;
      if (S.idx >= S.queue.length) S.idx = 0;
      renderAllLists(); return;
    }
  }
  S.queue = [...pl];
  if (S.random) fisherYates(S.queue);
  S.idx = 0; saveStateToBrowser(); renderAllLists();
}

function fisherYates(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function getSong(name) { return S.playlist.find(s => s.name === name) || null; }

function fadeAudio(targetVolPct, duration = 750, callback = null) {
  clearInterval(fadeInterval);
  if (!audReady) { if (callback) callback(); return; }
  
  const steps = 20;
  const stepTime = duration / steps;
  const maxVol = Math.max(0.1, S.volume / 100);
  const target = (targetVolPct / 100) * maxVol;
  const stepVol = (target - (gainNode ? gainNode.gain.value : aud.volume)) / steps;

  fadeInterval = setInterval(() => {
    let currentVol = gainNode ? gainNode.gain.value : aud.volume;
    let nextVol = currentVol + stepVol;
    
    if ((stepVol > 0 && nextVol >= target) || (stepVol < 0 && nextVol <= target)) {
      if (gainNode) gainNode.gain.value = target;
      aud.volume = target;
      clearInterval(fadeInterval);
      if (callback) callback();
    } else {
      let safeVol = Math.max(0, Math.min(1, nextVol));
      if (gainNode) gainNode.gain.value = safeVol;
      aud.volume = safeVol;
    }
  }, stepTime);
}

async function playTrack(qIdx, isResume = false) {
  countAdded = false; isNextPress = false; totalSeekMs = 0; S.idx = qIdx;
  const name = S.queue[qIdx];
  const song = getSong(name);
  if (!song) return;

  ensureAudioCtx();
  
  // KIỂM TRA BỘ NHỚ TRƯỚC KHI PHÁT
  aud.src = await getAudioSrc(song.url); 
  aud.load();
  aud.volume = 0; 
  if (gainNode) gainNode.gain.value = 0;

  aud.play().then(() => {
      fadeAudio(100, 750);
  }).catch(() => setStatus('Trình duyệt chặn tự động phát'));

  let targetTime = (isResume && S.savedTime > 0) ? S.savedTime : 0;
  if (!targetTime) {
    const lowName = name.toLowerCase();
    for (const [key, val] of Object.entries(SONG_STARTS)) { if (lowName.includes(key)) { targetTime = val; break; } }
  }

  if (targetTime > 0) {
    aud.addEventListener('canplay', function h() { aud.currentTime = targetTime; aud.removeEventListener('canplay', h); }, { once: true });
  }

  setTitle(name); renderAllLists(); saveStateToBrowser();

  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: name, artist: "SMusic Player" });
    navigator.mediaSession.setActionHandler('play', togglePlay);
    navigator.mediaSession.setActionHandler('pause', togglePlay);
    navigator.mediaSession.setActionHandler('previoustrack', prevTrackBtn);
    navigator.mediaSession.setActionHandler('nexttrack', nextTrackBtn);
  }
}

function togglePlay() {
  ensureAudioCtx();
  if (aud.paused) { 
      if (!aud.src || aud.src === location.href) playTrack(S.idx, true);
      else aud.play().then(() => fadeAudio(100, 750));
  } else { 
      fadeAudio(0, 750, () => { aud.pause(); saveStateToBrowser(); });
  }
}

function nextTrackBtn() { isNextPress = true; fadeAudio(0, 300, nextTrack); }
function prevTrackBtn() { fadeAudio(0, 300, prevTrack); }

function nextTrack() {
  if (!S.queue.length) return;
  const lastSong = S.queue[S.idx]; S.idx++; S.savedTime = 0;
  if (S.idx >= S.queue.length) {
    if (S.random && S.playlist.length > 1) {
      let tries = 0; do { fisherYates(S.queue); tries++; } while (S.queue[0] === lastSong && tries < 8);
    }
    S.idx = 0;
  }
  saveStateToBrowser(); playTrack(S.idx, false);
}

function prevTrack() {
  if (!S.queue.length) return;
  S.idx--; S.savedTime = 0;
  if (S.idx < 0) S.idx = S.queue.length - 1;
  saveStateToBrowser(); playTrack(S.idx, false);
}

aud.addEventListener('ended', nextTrack);
aud.addEventListener('timeupdate', () => {
  if (dragging || !aud.duration) return;
  const pct = aud.currentTime / aud.duration;
  document.getElementById('progress').value = Math.round(pct * 1000);
  document.getElementById('time-lbl').textContent = fmt(aud.currentTime) + ' / ' + fmt(aud.duration);
});

function hookProgress() {
  const sl = document.getElementById('progress');
  sl.addEventListener('mousedown',  () => { dragging = true; seekSnapStart = aud.currentTime; });
  sl.addEventListener('touchstart', () => { dragging = true; seekSnapStart = aud.currentTime; }, {passive: true});
  sl.addEventListener('change', () => {
    if (!aud.duration) { dragging = false; return; }
    const t = (sl.value / 1000) * aud.duration;
    totalSeekMs += Math.abs(t - seekSnapStart) * 1000;
    aud.currentTime = t; seekSnapStart = t; dragging = false; saveStateToBrowser();
  });
}

function hookVolume() {
  const sl = document.getElementById('vol-sl'); sl.value = S.volume;
  document.getElementById('vol-lbl').textContent = S.volume + '%';
  sl.addEventListener('input', () => {
    S.volume = +sl.value; document.getElementById('vol-lbl').textContent = S.volume + '%';
    const realVol = S.volume / 100;
    aud.volume = realVol; if (gainNode) gainNode.gain.value = realVol;
    saveStateToBrowser();
  });
}

function hookGestures() {
    let touchStartX = 0;
    document.body.addEventListener('touchstart', e => {
        if(['INPUT','BUTTON'].includes(e.target.tagName)) return; 
        touchStartX = e.changedTouches[0].screenX;
    }, {passive: true});
    
    document.body.addEventListener('touchend', e => {
        if(['INPUT','BUTTON'].includes(e.target.tagName)) return;
        let diff = e.changedTouches[0].screenX - touchStartX;
        if (diff > 80) prevTrackBtn();
        if (diff < -80) nextTrackBtn();
    }, {passive: true});
}

function toggleMode() {
  S.random = !S.random;
  document.getElementById('btn-mode').textContent = S.random ? '[ Ngẫu nhiên ]' : '[ Tuần tự ]';
  saveStateToBrowser();
}

function ensureAudioCtx() {
  if (audReady) { if (actx.state === 'suspended') actx.resume(); return; }
  actx = new (window.AudioContext || window.webkitAudioContext)();
  const src = actx.createMediaElementSource(aud);
  let last = src;
  for (let i = 0; i < 6; i++) {
    const f = actx.createBiquadFilter(); f.type = EQ_TYPES[i]; f.frequency.value = EQ_FREQS[i];
    f.gain.value = S.eq[i]; f.Q.value = 1.0; last.connect(f); last = f; eqFilters.push(f);
  }
  analyser = actx.createAnalyser(); analyser.fftSize = 512; analyser.smoothingTimeConstant = 0.8;
  last.connect(analyser); gainNode = actx.createGain(); gainNode.gain.value = S.volume / 100;
  analyser.connect(gainNode); gainNode.connect(actx.destination);
  audReady = true; startSpec();
}

let specRaf = null; let specW = 0;
function startSpec() {
  if (specRaf) return;
  const cv  = document.getElementById('spec-canvas'); const ctx = cv.getContext('2d'); const BARS = 32;
  function frame() {
    if (!S.spectrum) { specRaf = null; return; }
    specRaf = requestAnimationFrame(frame);
    const W = cv.clientWidth || cv.offsetWidth || 600; if (W !== specW) { cv.width = W; specW = W; }
    const H = cv.height; ctx.fillStyle = '#060a14'; ctx.fillRect(0, 0, W, H);
    const bw = W / BARS;
    if (!analyser) return;
    const buf = analyser.frequencyBinCount; const da = new Uint8Array(buf); analyser.getByteFrequencyData(da);
    const step = Math.max(1, Math.floor(buf / BARS));
    for (let i = 0; i < BARS; i++) {
      let sum = 0; for (let j = 0; j < step; j++) sum += da[Math.min(i*step+j, buf-1)];
      const avg = sum / step; const h = Math.max(3, (avg / 255) * (H - 4));
      ctx.fillStyle = '#22d3ee';
      ctx.fillRect(i*bw+1, H-h, bw-2, h);
    }
  }
  frame();
}

// --- TÍNH NĂNG PICTURE-IN-PICTURE ---
async function togglePiP() {
  const video = document.getElementById('pip-video');
  const canvas = document.getElementById('spec-canvas');
  if (document.pictureInPictureElement) {
    await document.exitPictureInPicture();
  } else {
    // Truyền dữ liệu canvas sang một video giả để thu nhỏ
    const stream = canvas.captureStream(30); 
    video.srcObject = stream;
    await video.play();
    await video.requestPictureInPicture();
  }
}

function setTitle(name) { document.getElementById('song-title').textContent = `[ ${name} ]`; }

function renderAllLists() {
  const qEl = document.getElementById('queue-wrap'); qEl.innerHTML = '';
  const pEl = document.getElementById('pgrid'); pEl.innerHTML = '';

  for (let i = 0; i < S.queue.length; i++) {
    const n = S.queue[i];
    const song = getSong(n);
    const isNow = (i === S.idx);
    const d = document.createElement('div'); 
    d.className = 'qitem' + (isNow ? ' now' : '');

    // Nút download dựa trên bộ nhớ đệm
    const isCached = song && cacheManifest.has(song.url);
    const btnHtml = isCached 
      ? `<button class="dl-btn" disabled>[ Đã lưu ]</button>`
      : `<button class="dl-btn" id="dl-q${i}" onclick="event.stopPropagation(); downloadSong('${song?.url}', 'q${i}')">[ Tải về ]</button>`;

    d.innerHTML = `<span>${isNow ? '->' : '-'}</span><span class="qname">${n}</span>${btnHtml}`;
    d.addEventListener('dblclick', () => { S.savedTime = 0; playTrack(i, false); });
    
    qEl.appendChild(d);
    pEl.appendChild(d.cloneNode(true)); // Dùng chung layout cho 2 tab cho đồng bộ
  }
  
  const playing = qEl.querySelector('.now'); 
  if (playing) setTimeout(() => playing.scrollIntoView({behavior:'smooth',block:'nearest'}), 80);
}

function applyUI() {
  document.getElementById('vol-sl').value = S.volume; document.getElementById('vol-lbl').textContent = S.volume + '%';
  document.getElementById('btn-mode').textContent = S.random ? '[ Ngẫu nhiên ]' : '[ Tuần tự ]';
  renderAllLists();
  if (S.queue[S.idx]) setTitle(S.queue[S.idx]);
}

function tickUI() { document.getElementById('btn-play').textContent = aud.paused ? '[ Phát ]' : '[ Dừng ]'; }

function hookTabs() {
  const tabs = ['control','eq','spectrum','playlist'];
  document.querySelectorAll('.tabbar button').forEach((btn, i) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tabbar button').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('on'));
      btn.classList.add('active'); document.getElementById('tab-' + tabs[i]).classList.add('on');
    });
  });
}

function fmt(sec) {
  if (!sec || isNaN(sec)) return '00:00'; sec = Math.max(0, Math.floor(sec));
  return String(Math.floor(sec/60)).padStart(2,'0') + ':' + String(sec%60).padStart(2,'0');
}
function setStatus(msg) { document.getElementById('statusbar').textContent = msg; }
function hideLoader() { document.getElementById('loader').style.display = 'none'; }

init();
