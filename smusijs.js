const WEB_APP_URL = "https://script.google.com/macros/s/AKfycbwUgRFtf6SdwgFQ1RP6QpIxzxzshCDT0E_jypErRxebcqFIrmDwqdUQy9S87oIVWJWE9Q/exec";
const STORE_KEY  = 'smusic_full_storage';
const EQ_FREQS   = [60, 150, 400, 1000, 2400, 15000];
const EQ_LABELS  = ['60Hz','150Hz','400Hz','1KHz','2.4KHz','15KHz'];
const EQ_TYPES   = ['lowshelf','peaking','peaking','peaking','peaking','highshelf'];

let S = { playlist: [], queue: [], idx: 0, random: true, volume: 100, eq: [0,0,0,0,0,0], spectrum: true, savedTime: 0 };
let cacheManifest = new Set(); 

const aud = document.getElementById('aud');
let actx = null, analyser = null, gainNode = null, mediaSource = null;
const eqFilters = [];
let audReady = false;
let fadeInterval = null;

// Khởi tạo
async function init() {
  loadStateFromBrowser();
  buildEQSliders(); 
  hookTabs();
  hookProgress();
  hookVolume();
  await refreshCacheManifest();
  await fetchFromGoogle();
  applyUI();
  setInterval(tickUI, 200);
  setInterval(saveStateToBrowser, 2000); // Lưu tiến trình mỗi 2 giây
  
  document.getElementById('spec-chk').addEventListener('change', (e) => {
    S.spectrum = e.target.checked;
    if(S.spectrum) startSpec();
  });
}

// Lưu và Tải trạng thái
function loadStateFromBrowser() {
  try { const s = localStorage.getItem(STORE_KEY); if (s) Object.assign(S, JSON.parse(s)); } catch(e) {}
}
function saveStateToBrowser() {
  try { 
    if (aud.currentTime > 0) S.savedTime = aud.currentTime;
    localStorage.setItem(STORE_KEY, JSON.stringify(S)); 
  } catch(e) {}
}

// Volume
function hookVolume() {
  const volSlider = document.getElementById('volume');
  const volLbl = document.getElementById('vol-lbl');
  if (!volSlider) return;
  volSlider.value = S.volume;
  volLbl.textContent = S.volume + '%';
  
  volSlider.addEventListener('input', (e) => {
    S.volume = parseInt(e.target.value);
    volLbl.textContent = S.volume + '%';
    const realVol = S.volume / 100;
    aud.volume = realVol;
    if (gainNode) gainNode.gain.setValueAtTime(realVol, actx.currentTime);
    saveStateToBrowser();
  });
}

// Fade in / Fade out
function fadeAudio(targetVolPct, duration = 750, callback = null) {
  clearInterval(fadeInterval);
  if (!audReady) { if (callback) callback(); return; }
  
  const steps = 20;
  const stepTime = duration / steps;
  const maxVol = Math.max(0.01, S.volume / 100); 
  const target = (targetVolPct / 100) * maxVol;
  const currentVol = aud.volume;
  const stepVol = (target - currentVol) / steps;

  fadeInterval = setInterval(() => {
    let nextVol = aud.volume + stepVol;
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

// Xử lý Audio Context (Sửa lỗi EQ không hoạt động)
function ensureAudioCtx() {
  if (actx && actx.state === 'suspended') actx.resume();
  if (audReady) return;
  
  actx = new (window.AudioContext || window.webkitAudioContext)();
  
  // Rất quan trọng: Chỉ tạo MediaElementSource 1 lần duy nhất
  mediaSource = actx.createMediaElementSource(aud);
  
  let lastNode = mediaSource;
  eqFilters.length = 0; 
  for (let i = 0; i < 6; i++) {
    const filter = actx.createBiquadFilter();
    filter.type = EQ_TYPES[i];
    filter.frequency.value = EQ_FREQS[i];
    filter.gain.value = S.eq[i];
    lastNode.connect(filter);
    lastNode = filter;
    eqFilters.push(filter);
  }
  
  analyser = actx.createAnalyser(); 
  analyser.fftSize = 256;
  lastNode.connect(analyser);
  
  gainNode = actx.createGain();
  gainNode.gain.value = S.volume / 100;
  analyser.connect(gainNode);
  gainNode.connect(actx.destination);
  
  audReady = true; 
  startSpec();
}

// Quản lý Offline (Cache)
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

// Tải một bài hát
function downloadSong(url, idStr) {
  const btn = document.getElementById(idStr);
  if (btn) { btn.innerText = "[ 0% ]"; btn.disabled = true; }

  const xhr = new XMLHttpRequest();
  xhr.open('GET', url, true);
  xhr.responseType = 'blob';

  xhr.onprogress = (e) => {
    if (e.lengthComputable && btn) btn.innerText = `[ ${Math.round((e.loaded / e.total) * 100)}% ]`;
  };

  xhr.onload = async () => {
    if (xhr.status === 200) {
      const cache = await caches.open('smusic-cache');
      await cache.put(url, new Response(xhr.response));
      cacheManifest.add(url);
      renderAllLists();
    } else {
      if(btn) { btn.innerText = "[ Lỗi ]"; btn.disabled = false; }
    }
  };
  xhr.send();
}

// Tải tất cả
async function downloadAllSongs() {
  const mainBtn = document.getElementById('btn-dl-all');
  if (!S.playlist || S.playlist.length === 0) return;
  
  mainBtn.disabled = true;
  let total = S.playlist.length;
  let count = 0;

  for (let i = 0; i < S.playlist.length; i++) {
    const song = S.playlist[i];
    if (cacheManifest.has(song.url)) { count++; continue; }

    mainBtn.innerText = `⬇️ Đang tải: ${count + 1}/${total}`;
    try {
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', song.url, true);
        xhr.responseType = 'blob';
        xhr.onload = async () => {
          if (xhr.status === 200) {
            const cache = await caches.open('smusic-cache');
            await cache.put(song.url, new Response(xhr.response));
            cacheManifest.add(song.url);
            renderAllLists();
            resolve();
          } else reject();
        };
        xhr.onerror = reject;
        xhr.send();
      });
      count++;
    } catch (err) { console.warn("Lỗi bài: " + song.name); }
  }
  mainBtn.innerText = "✅ Tải hoàn tất";
  setTimeout(() => { mainBtn.innerText = "⬇️ Tải tất cả nhạc"; mainBtn.disabled = false; }, 3000);
}

// Xóa tất cả bộ nhớ
async function clearAllCache() {
  if (!confirm("Bạn có chắc chắn muốn xóa toàn bộ nhạc đã tải để giải phóng dung lượng?")) return;
  const cache = await caches.open('smusic-cache');
  const keys = await cache.keys();
  for (const key of keys) await cache.delete(key);
  cacheManifest.clear();
  renderAllLists();
  alert("Đã dọn dẹp sạch sẽ bộ nhớ!");
}

// Lấy dữ liệu Google
async function fetchFromGoogle() {
  document.getElementById('statusbar').textContent = 'Đang đồng bộ dữ liệu...';
  try {
    const res = await fetch(WEB_APP_URL);
    const data = await res.json();
    S.playlist = data.songs.filter(s => s.name && s.url);
    document.getElementById('statusbar').textContent = `Đã đồng bộ ${S.playlist.length} bài hát`;
    S.queue = [...S.playlist.map(s => s.name)];
    renderAllLists();
  } catch(err) {
    document.getElementById('statusbar').textContent = 'Lỗi kết nối API';
  }
}

function getSong(name) { return S.playlist.find(s => s.name === name) || null; }

// Điều khiển âm nhạc
async function playTrack(qIdx, isResume = false) {
  S.idx = qIdx;
  const name = S.queue[qIdx];
  const song = getSong(name);
  if (!song) return;

  ensureAudioCtx();
  
  aud.src = await getAudioSrc(song.url);
  aud.load();
  aud.volume = 0; 
  if (gainNode) gainNode.gain.value = 0;

  aud.play().then(() => {
    fadeAudio(100, 750); // Mở nhạc từ từ (Fade In)
  }).catch(e => console.log("Cần tương tác để phát", e));
  
  // Phục hồi thời gian nghe dở
  let targetTime = (isResume && S.savedTime > 0) ? S.savedTime : 0;
  if (targetTime > 0) {
    aud.addEventListener('canplay', function h() { 
      aud.currentTime = targetTime; 
      aud.removeEventListener('canplay', h); 
    }, { once: true });
  }

  document.getElementById('song-title').textContent = name;
  renderAllLists();
  saveStateToBrowser();
}

function togglePlay() {
  ensureAudioCtx();
  if (aud.paused) { 
    if (!aud.src || aud.src === location.href) playTrack(S.idx, true); 
    else aud.play().then(() => fadeAudio(100, 750)); 
  } else { 
    fadeAudio(0, 750, () => aud.pause()); // Tắt nhạc từ từ (Fade Out) rồi mới dừng
  }
}

function nextTrack() {
  S.savedTime = 0; // Chuyển bài là reset time
  if (S.queue.length === 0) return;
  if (S.random) S.idx = Math.floor(Math.random() * S.queue.length);
  else S.idx = (S.idx + 1) % S.queue.length;
  fadeAudio(0, 300, () => playTrack(S.idx));
}

function prevTrack() {
  S.savedTime = 0;
  if (S.queue.length === 0) return;
  S.idx = (S.idx - 1 + S.queue.length) % S.queue.length;
  fadeAudio(0, 300, () => playTrack(S.idx));
}

aud.addEventListener('ended', nextTrack);

function hookProgress() {
  const sl = document.getElementById('progress');
  let dragging = false;
  sl.addEventListener('mousedown', () => dragging = true);
  sl.addEventListener('touchstart', () => dragging = true, {passive: true});
  
  aud.addEventListener('timeupdate', () => {
    if (aud.duration && !dragging) {
      sl.value = (aud.currentTime / aud.duration) * 1000;
      document.getElementById('time-lbl').textContent = fmt(aud.currentTime) + ' / ' + fmt(aud.duration);
    }
  });
  
  sl.addEventListener('change', () => {
    if (aud.duration) aud.currentTime = (sl.value / 1000) * aud.duration;
    dragging = false;
    saveStateToBrowser();
  });
}

// EQ Logic và Thuật toán Hermite Spline (Fix lỗi cong)
function drawEQ() {
  const cv = document.getElementById('eq-canvas');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const W = cv.width = cv.offsetWidth; 
  const H = cv.height = 160;
  
  ctx.fillStyle = '#040812'; ctx.fillRect(0, 0, W, H);
  
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)'; ctx.lineWidth = 1;
  for (let db = -10; db <= 10; db += 5) {
    let y = H / 2 - (db / 15) * (H / 2 - 20);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  const padding = 40; const step = (W - padding * 2) / 5; const points = [];
  for (let i = 0; i < 6; i++) {
    const x = padding + i * step;
    const y = H / 2 - (S.eq[i] / 15) * (H / 2 - 20);
    points.push({ x, y });
  }
  
  ctx.strokeStyle = 'var(--cyan)'; ctx.lineWidth = 2.5; ctx.beginPath();
  for (let x = 0; x < W; x++) {
    if (x <= points[0].x) { if (x === 0) ctx.moveTo(x, points[0].y); else ctx.lineTo(x, points[0].y); } 
    else if (x >= points[5].x) ctx.lineTo(x, points[5].y);
    else {
      let i = 0; while (i < 5 && x > points[i+1].x) i++;
      const p0 = points[i], p1 = points[i+1];
      const t = (x - p0.x) / (p1.x - p0.x);
      // Hermite Spline cục bộ: không lây lan sự uốn cong sang điểm khác
      const h00 = 2 * Math.pow(t, 3) - 3 * Math.pow(t, 2) + 1;
      const h01 = -2 * Math.pow(t, 3) + 3 * Math.pow(t, 2);
      ctx.lineTo(x, p0.y * h00 + p1.y * h01);
    }
  }
  ctx.stroke();
  
  ctx.lineTo(W, H); ctx.lineTo(0, H);
  ctx.fillStyle = 'rgba(34, 211, 238, 0.05)'; ctx.fill();

  points.forEach((p, i) => {
    ctx.fillStyle = 'var(--blue)'; ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = 'var(--muted)'; ctx.font = '10px monospace'; ctx.textAlign = 'center'; ctx.fillText(EQ_LABELS[i], p.x, H - 8);
    ctx.fillStyle = 'var(--white)'; ctx.fillText((S.eq[i] > 0 ? '+' : '') + S.eq[i], p.x, p.y - 12);
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
      <input type="range" min="-15" max="15" step="1" value="${S.eq[i]}" id="eq-${i}">
      <span>-15</span>
    `;
    container.appendChild(wrap);
    
    wrap.querySelector('input').addEventListener('input', (e) => {
      S.eq[i] = parseFloat(e.target.value);
      if (eqFilters[i]) eqFilters[i].gain.setValueAtTime(S.eq[i], actx.currentTime);
      drawEQ(); 
      saveStateToBrowser();
    });
  });
  setTimeout(drawEQ, 50); 
}

// Sóng Spectrum
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
      ctx.fillStyle = 'var(--cyan)';
      ctx.fillRect(i * barW + 1, H - h, barW - 2, h);
    }
  }
  frame();
}

// Picture in Picture
async function togglePiP() {
  const video = document.getElementById('pip-video');
  const canvas = document.getElementById('spec-canvas');
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else {
      video.srcObject = canvas.captureStream(30); 
      await video.play();
      await video.requestPictureInPicture();
    }
  } catch(e) { console.error("PiP error", e); }
}

// Giao diện
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
      : `<button class="dl-btn" id="dl-q${i}" onclick="event.stopPropagation(); downloadSong('${song?.url}', 'dl-q${i}')">[ Tải ]</button>`;

    d.innerHTML = `<span class="qname">${n}</span>${btnHtml}`;
    d.querySelector('.qname').onclick = () => playTrack(i, false);
    
    if(qEl) qEl.appendChild(d);
    if(pEl) pEl.appendChild(d.cloneNode(true));
  });
}

function toggleMode() { S.random = !S.random; applyUI(); saveStateToBrowser(); }
function applyUI() { 
  document.getElementById('btn-mode').textContent = S.random ? '🔄 Ngẫu nhiên' : '🔄 Tuần tự';
  renderAllLists();
}
function tickUI() { document.getElementById('btn-play').textContent = aud.paused ? '▶ Phát' : '⏸ Dừng'; }

function hookTabs() {
  const tabs = ['control','eq','spectrum','playlist'];
  document.querySelectorAll('.tabbar button').forEach((btn, i) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tabbar button, .tab').forEach(el => { el.classList.remove('active'); el.classList.remove('on'); });
      btn.classList.add('active'); 
      document.getElementById('tab-' + tabs[i]).classList.add('on');
      if (tabs[i] === 'eq') setTimeout(drawEQ, 60);
      if (tabs[i] === 'spectrum' && S.spectrum) startSpec();
    });
  });
}

function fmt(sec) {
  if (!sec || isNaN(sec)) return '00:00'; sec = Math.floor(sec);
  return String(Math.floor(sec/60)).padStart(2,'0') + ':' + String(sec%60).padStart(2,'0');
}

/* ── SCREENSAVER ── */
let timer;
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
  timer = setTimeout(showScreensaver, 15000); // 15 giây
}

ss.addEventListener('click', (e) => { e.stopPropagation(); hideScreensaver(); });
['mousemove','mousedown','touchstart','keydown','scroll'].forEach(ev => {
  document.addEventListener(ev, () => { if (!active) resetTimer(); }, { passive: true });
});

new MutationObserver(() => {
  if (active) ssSong.textContent = songTitle.textContent;
}).observe(songTitle, { childList: true, subtree: true, characterData: true });

init();
