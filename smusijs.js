/* ============================================================
   CONFIG - LINK TỚI GOOGLE APPS SCRIPT
   ============================================================ */
const WEB_APP_URL = "https://script.google.com/macros/s/AKfycbwUgRFtf6SdwgFQ1RP6QpIxzxzshCDT0E_jypErRxebcqFIrmDwqdUQy9S87oIVWJWE9Q/exec";

const STORE_KEY  = 'smusic_supabase_storage';
const EQ_FREQS   = [60, 150, 400, 1000, 2400, 15000];
const EQ_LABELS  = ['60Hz','150Hz','400Hz','1KHz','2.4KHz','15KHz'];
const EQ_TYPES   = ['lowshelf','peaking','peaking','peaking','peaking','highshelf'];
const SONG_STARTS = { 'leave me alone': 22, 'broken strings': 30 };

let S = { playlist: [], queue: [], idx: 0, random: true, volume: 100, counts: {}, eq: [0,0,0,0,0,0], spectrum: true, savedTime: 0 };
let cacheManifest = new Set(); // Bộ nhớ Offline

const aud = document.getElementById('aud');
let actx = null, analyser = null, gainNode = null;
const eqFilters = [];
let audReady = false;

/* ── SCREENSAVER LOGIC ── */
let timer;
const IDLE_DELAY = 10000; // 10 giây
const ss = document.getElementById('screensaver');
const ssSong = document.getElementById('ss-song');
const songTitle = document.getElementById('song-title');
let active = false;

function showScreensaver() {
  if (active || aud.paused) return;
  active = true;
  ss.classList.add('ss-active');
  ssSong.textContent = songTitle.textContent;
}

function hideScreensaver() {
  if (!active) return;
  active = false;
  ss.classList.remove('ss-active');
  resetTimer();
}

function resetTimer() {
  if (active) return;
  clearTimeout(timer);
  timer = setTimeout(showScreensaver, IDLE_DELAY);
}

ss.addEventListener('click', (e) => { e.stopPropagation(); hideScreensaver(); });
['mousemove','mousedown','touchstart','keydown','scroll','wheel'].forEach(ev => {
  document.addEventListener(ev, () => { if (!active) resetTimer(); }, { passive: true });
});

new MutationObserver(() => {
  if (active) ssSong.textContent = songTitle.textContent;
}).observe(songTitle, { childList: true, subtree: true, characterData: true });

/* ── KHỞI TẠO HỆ THỐNG ── */
async function init() {
  loadStateFromBrowser();
  buildEQSliders(); // Khôi phục hàm EQ không bị lỗi nữa
  hookTabs();
  hookProgress();
  await refreshCacheManifest();
  await fetchFromGoogle();
  applyUI();
  setInterval(tickUI, 200);
  
  document.getElementById('spec-chk').addEventListener('change', (e) => {
    S.spectrum = e.target.checked;
    if(S.spectrum) startSpec();
  });
}

function loadStateFromBrowser() {
  try { const s = localStorage.getItem(STORE_KEY); if (s) Object.assign(S, JSON.parse(s)); } catch(e) {}
}

function saveStateToBrowser() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch(e) {}
}

/* ── TẢI VÀ CACHE OFFLINE (TÍNH NĂNG MỚI) ── */
async function refreshCacheManifest() {
  try {
    const cache = await caches.open('smusic-cache');
    const keys = await cache.keys();
    cacheManifest = new Set(keys.map(req => req.url));
  } catch(e) {}
}

async function getAudioSrc(url) {
  if (cacheManifest.has(url)) {
    const cache = await caches.open('smusic-cache');
    const res = await cache.match(url);
    if (res) return URL.createObjectURL(await res.blob());
  }
  return url;
}

function downloadSong(url, idStr) {
  const btn = document.getElementById(idStr);
  if (btn) btn.innerText = "[ Đang tải... ]";

  const xhr = new XMLHttpRequest();
  xhr.open('GET', url, true);
  xhr.responseType = 'blob';

  xhr.onprogress = (e) => {
    if (e.lengthComputable && btn) {
      btn.innerText = `[ ${Math.round((e.loaded / e.total) * 100)}% ]`;
    }
  };

  xhr.onload = async () => {
    if (xhr.status === 200) {
      const cache = await caches.open('smusic-cache');
      await cache.put(url, new Response(xhr.response));
      cacheManifest.add(url);
      renderAllLists();
    }
  };
  xhr.send();
}

/* ── PICTURE-IN-PICTURE (TÍNH NĂNG MỚI) ── */
async function togglePiP() {
  const video = document.getElementById('pip-video');
  const canvas = document.getElementById('spec-canvas');
  if (document.pictureInPictureElement) {
    await document.exitPictureInPicture();
  } else {
    const stream = canvas.captureStream(30); 
    video.srcObject = stream;
    await video.play();
    await video.requestPictureInPicture();
  }
}

/* ── FETCH GOOGLE ── */
async function fetchFromGoogle() {
  document.getElementById('statusbar').textContent = 'Đang tải dữ liệu...';
  try {
    const res = await fetch(WEB_APP_URL);
    const data = await res.json();
    S.playlist = data.songs.filter(s => s.name && s.url);
    document.getElementById('statusbar').textContent = `Đã tải ${S.playlist.length} bài`;
    S.queue = [...S.playlist.map(s => s.name)];
    renderAllLists();
  } catch(err) {
    document.getElementById('statusbar').textContent = 'Lỗi: ' + err.message;
  }
}

function getSong(name) { return S.playlist.find(s => s.name === name) || null; }

/* ── AUDIO & EQ CONTROLS ── */
async function playTrack(qIdx) {
  S.idx = qIdx;
  const name = S.queue[qIdx];
  const song = getSong(name);
  if (!song) return;

  ensureAudioCtx();
  aud.src = await getAudioSrc(song.url);
  aud.play().catch(e => console.log(e));
  
  songTitle.textContent = name;
  renderAllLists();
  saveStateToBrowser();
}

function togglePlay() {
  ensureAudioCtx();
  if (aud.paused) { 
    if (!aud.src) playTrack(S.idx); else aud.play(); 
  } else { aud.pause(); }
}

function nextTrack() {
  S.idx++;
  if (S.idx >= S.queue.length) S.idx = 0;
  playTrack(S.idx);
}

function prevTrack() {
  S.idx--;
  if (S.idx < 0) S.idx = S.queue.length - 1;
  playTrack(S.idx);
}

aud.addEventListener('ended', nextTrack);

function hookProgress() {
  const sl = document.getElementById('progress');
  aud.addEventListener('timeupdate', () => {
    if (aud.duration) {
      sl.value = (aud.currentTime / aud.duration) * 1000;
      document.getElementById('time-lbl').textContent = fmt(aud.currentTime) + ' / ' + fmt(aud.duration);
    }
  });
  sl.addEventListener('change', () => {
    if (aud.duration) aud.currentTime = (sl.value / 1000) * aud.duration;
  });
}

function buildEQSliders() {
  const container = document.getElementById('eq-container');
  if (!container) return;
  container.innerHTML = '';
  EQ_FREQS.forEach((freq, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'eq-slider-wrap';
    wrap.innerHTML = `
      <span>+15</span>
      <input type="range" min="-15" max="15" value="${S.eq[i]}" id="eq-${i}">
      <span>-15</span>
      <span style="margin-top:8px;">${EQ_LABELS[i]}</span>
    `;
    container.appendChild(wrap);
    wrap.querySelector('input').addEventListener('input', (e) => {
      S.eq[i] = parseFloat(e.target.value);
      if (eqFilters[i]) eqFilters[i].gain.value = S.eq[i];
      saveStateToBrowser();
    });
  });
}

function ensureAudioCtx() {
  if (audReady) return;
  actx = new (window.AudioContext || window.webkitAudioContext)();
  const src = actx.createMediaElementSource(aud);
  let last = src;
  for (let i = 0; i < 6; i++) {
    const f = actx.createBiquadFilter(); f.type = EQ_TYPES[i]; f.frequency.value = EQ_FREQS[i];
    f.gain.value = S.eq[i]; last.connect(f); last = f; eqFilters.push(f);
  }
  analyser = actx.createAnalyser(); analyser.fftSize = 256;
  last.connect(analyser); analyser.connect(actx.destination);
  audReady = true; startSpec();
}

function startSpec() {
  const cv = document.getElementById('spec-canvas');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  function frame() {
    if (!S.spectrum) return;
    requestAnimationFrame(frame);
    const W = cv.width = cv.offsetWidth; const H = cv.height;
    ctx.fillStyle = '#060a14'; ctx.fillRect(0,0,W,H);
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    const barW = W / 32;
    for (let i = 0; i < 32; i++) {
      const h = (data[i] / 255) * H;
      ctx.fillStyle = '#22d3ee';
      ctx.fillRect(i * barW + 1, H - h, barW - 2, h);
    }
  }
  frame();
}

function renderAllLists() {
  const qEl = document.getElementById('queue-wrap');
  const pEl = document.getElementById('pgrid');
  if(qEl) qEl.innerHTML = '';
  if(pEl) pEl.innerHTML = '';

  S.queue.forEach((n, i) => {
    const song = getSong(n);
    const isNow = (i === S.idx);
    const d = document.createElement('div');
    d.className = 'qitem' + (isNow ? ' now' : '');

    const isCached = song && cacheManifest.has(song.url);
    const btnHtml = isCached 
      ? `<button class="dl-btn" disabled>[ Đã lưu ]</button>`
      : `<button class="dl-btn" id="dl-${i}" onclick="event.stopPropagation(); downloadSong('${song?.url}', 'dl-${i}')">[ Tải về ]</button>`;

    d.innerHTML = `<span class="qname">${n}</span>${btnHtml}`;
    d.querySelector('.qname').onclick = () => playTrack(i);
    
    if(qEl) qEl.appendChild(d);
    if(pEl) pEl.appendChild(d.cloneNode(true));
  });
}

function toggleMode() { S.random = !S.random; applyUI(); saveStateToBrowser(); }
function applyUI() { 
  document.getElementById('btn-mode').textContent = S.random ? 'Chế độ: Ngẫu nhiên' : 'Chế độ: Tuần tự';
  renderAllLists();
}
function tickUI() { document.getElementById('btn-play').textContent = aud.paused ? '▶ Play' : '⏸ Pause'; }

function hookTabs() {
  const tabs = ['control','eq','spectrum','playlist'];
  document.querySelectorAll('.tabbar button').forEach((btn, i) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tabbar button, .tab').forEach(el => { el.classList.remove('active'); el.classList.remove('on'); });
      btn.classList.add('active'); document.getElementById('tab-' + tabs[i]).classList.add('on');
    });
  });
}

function fmt(sec) {
  if (!sec || isNaN(sec)) return '00:00'; sec = Math.floor(sec);
  return String(Math.floor(sec/60)).padStart(2,'0') + ':' + String(sec%60).padStart(2,'0');
}

init();
