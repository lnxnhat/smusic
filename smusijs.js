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

const aud = document.getElementById('aud');
const cacheAud = document.getElementById('cache-aud'); // Cache layer
let actx = null, analyser = null, gainNode = null;
const eqFilters = [];
let audReady = false;

let countAdded = false, isNextPress = false, totalSeekMs = 0, dragging = false, seekSnapStart = 0;
let fadeInterval = null; // Quản lý Fade 750ms

async function init() {
  loadStateFromBrowser();
  buildEQSliders();
  hookProgress();
  hookVolume();
  hookTabs();
  hookGestures(); // Bật Swipe
  await fetchFromGoogle();
  applyUI();
  hideLoader();

  setInterval(saveStateToBrowser, 1000);
  setInterval(tickUI, 200);

  // iOS BACKGROUND FIX: Đánh thức AudioContext khi mở lại tab
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && actx && actx.state === 'suspended') {
      actx.resume();
    }
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

async function fetchFromGoogle() {
  setStatus('Đang tải Database từ Google Sheets...');
  if (!WEB_APP_URL.startsWith('https://script.google.com')) return setStatus('⚠️ Thiếu Link Apps Script hợp lệ trong script.js');

  try {
    const res  = await fetch(WEB_APP_URL);
    const data = await res.json();

    const validSongs = data.songs.filter(s => s.name && s.url);
    if (validSongs.length === 0) throw new Error('Không tìm thấy link nhạc trong Sheet!');

    S.playlist = validSongs;
    S.counts   = data.counts || {};

    setStatus(`✅ Đã đồng bộ ${S.playlist.length} bài hát từ hệ thống Cloud`);
    buildInitialQueue();
    renderGrid();
  } catch(err) {
    console.error('[SMusic] Lỗi fetch:', err);
    setStatus('⚠️ Lỗi: ' + err.message);
  }
}

async function pushCountToGoogle(songName) {
  try {
    await fetch(WEB_APP_URL, {
      method: 'POST',
      body: JSON.stringify({ action: 'updateCount', songName }),
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }
    });
  } catch(err) { console.warn('Lỗi đồng bộ lượt nghe:', err); }
}

function buildInitialQueue() {
  const pl = S.playlist.map(s => s.name);
  if (S.queue.length > 0) {
    const valid = S.queue.filter(n => pl.includes(n));
    if (valid.length) {
      S.queue = valid;
      if (S.idx >= S.queue.length) S.idx = 0;
      renderQueue(); return;
    }
  }
  S.queue = [...pl];
  if (S.random) fisherYates(S.queue);
  S.idx = 0; saveStateToBrowser(); renderQueue();
}

function fisherYates(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function getSong(name) {
  if (!name) return null;
  return S.playlist.find(s => s.name === name) || null;
}

// ==========================================
// LOGIC FADE IN / FADE OUT 750ms (ĐÃ FIX CHO WEB AUDIO API)
// ==========================================
function fadeAudio(targetVolPct, duration = 750, callback = null) {
  clearInterval(fadeInterval);
  if (!audReady) { if (callback) callback(); return; }
  
  const steps = 20;
  const stepTime = duration / steps;
  const maxVol = Math.max(0.1, S.volume / 100); // Lấy âm lượng người dùng đang set làm chuẩn
  const target = (targetVolPct / 100) * maxVol;
  const stepVol = (target - (gainNode ? gainNode.gain.value : aud.volume)) / steps;

  fadeInterval = setInterval(() => {
    let currentVol = gainNode ? gainNode.gain.value : aud.volume;
    let nextVol = currentVol + stepVol;
    
    if ((stepVol > 0 && nextVol >= target) || (stepVol < 0 && nextVol <= target)) {
      if (gainNode) gainNode.gain.value = target;
      aud.volume = target; // Set cả 2 để iOS không bị lỗi ngầm
      clearInterval(fadeInterval);
      if (callback) callback();
    } else {
      let safeVol = Math.max(0, Math.min(1, nextVol));
      if (gainNode) gainNode.gain.value = safeVol;
      aud.volume = safeVol;
    }
  }, stepTime);
}

function playTrack(qIdx, isResume = false) {
  countAdded = false; isNextPress = false; totalSeekMs = 0; S.idx = qIdx;
  const name = S.queue[qIdx];
  const song = getSong(name);
  if (!song || !song.url) return setStatus('⚠️ Lỗi dữ liệu bài hát: ' + name);

  ensureAudioCtx();
  
  aud.src = song.url; 
  aud.load();
  aud.volume = 0; // Bắt đầu Fade In
  if (gainNode) gainNode.gain.value = 0;

  aud.play().then(() => {
      fadeAudio(100, 750); // Fade In 750ms
  }).catch(e => setStatus('⚠️ Trình duyệt chặn tự động phát — Hãy bấm nút Play!'));

  let targetTime = (isResume && S.savedTime > 0) ? S.savedTime : 0;
  if (!targetTime) {
    const lowName = name.toLowerCase();
    for (const [key, val] of Object.entries(SONG_STARTS)) { if (lowName.includes(key)) { targetTime = val; break; } }
  }

  if (targetTime > 0) {
    aud.addEventListener('canplay', function h() { aud.currentTime = targetTime; aud.removeEventListener('canplay', h); }, { once: true });
  }

  setTitle(name); renderQueue(); renderGrid(); saveStateToBrowser();

  // OFFLINE-FIRST CACHING: Tải trước bài tiếp theo
  let nextSong = getSong(S.queue[(S.idx + 1) % S.queue.length]);
  if (nextSong) cacheAud.src = nextSong.url;

  // MEDIA SESSION API (BÁO CÁO VỚI IOS ĐỂ KHÔNG BỊ GIẾT NGẦM)
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: name, artist: "SMusic Cloud" });
    navigator.mediaSession.setActionHandler('play', togglePlay);
    navigator.mediaSession.setActionHandler('pause', togglePlay);
    navigator.mediaSession.setActionHandler('previoustrack', prevTrackBtn);
    navigator.mediaSession.setActionHandler('nexttrack', nextTrackBtn);
  }
}

function togglePlay() {
  ensureAudioCtx();
  if (aud.paused) { 
      if (!aud.src || aud.src === location.href) {
          playTrack(S.idx, true);
      } else {
          aud.play().then(() => fadeAudio(100, 750)); // Fade In
      }
  } else { 
      fadeAudio(0, 750, () => {
          aud.pause(); 
          saveStateToBrowser();
      }); // Fade Out rồi mới dừng
  }
}

function nextTrackBtn() { isNextPress = true; fadeAudio(0, 300, nextTrack); } // Fade out nhanh khi bấm Next
function prevTrackBtn() { fadeAudio(0, 300, prevTrack); }

function nextTrack() {
  if (!S.queue.length) return;
  const lastSong = S.queue[S.idx]; S.idx++; S.savedTime = 0;
  if (S.idx >= S.queue.length) {
    if (S.random && S.playlist.length > 1) {
      let tries = 0; do { fisherYates(S.queue); tries++; } while (S.queue[0] === lastSong && tries < 8);
      S.idx = 0;
    } else S.idx = 0;
    saveStateToBrowser();
  }
  playTrack(S.idx, false);
}

function prevTrack() {
  if (!S.queue.length) return;
  S.idx--; S.savedTime = 0;
  if (S.idx < 0) S.idx = S.queue.length - 1;
  saveStateToBrowser();
  playTrack(S.idx, false);
}

aud.addEventListener('ended', nextTrack);
aud.addEventListener('timeupdate', () => {
  if (dragging || !aud.duration) return;
  const pct = aud.currentTime / aud.duration;
  document.getElementById('progress').value = Math.round(pct * 1000);
  document.getElementById('time-lbl').textContent = fmt(aud.currentTime) + ' / ' + fmt(aud.duration);

  if (!countAdded && pct >= 0.9 && totalSeekMs <= 10000 && !isNextPress) {
    const songName = S.queue[S.idx];
    S.counts[songName] = (S.counts[songName] || 0) + 1; countAdded = true;
    renderQueue(); renderGrid(); pushCountToGoogle(songName);
  }
});
aud.addEventListener('error', (e) => setStatus('⚠️ Lỗi phát nhạc - Link Supabase có thể bị hỏng'));

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

// VUỐT NGANG (SWIPE) ĐỂ CHUYỂN BÀI
function hookGestures() {
    let touchStartX = 0;
    document.body.addEventListener('touchstart', e => {
        if(e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return; 
        touchStartX = e.changedTouches[0].screenX;
    }, {passive: true});
    
    document.body.addEventListener('touchend', e => {
        if(e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
        let diff = e.changedTouches[0].screenX - touchStartX;
        if (diff > 80) prevTrackBtn(); // Vuốt Phải -> Bài trước
        if (diff < -80) nextTrackBtn(); // Vuốt Trái -> Bài sau
    }, {passive: true});
}

// TOGGLE MINI PLAYER
function toggleMiniPlayerUI() {
    document.body.classList.toggle('mini-player-active');
    // Khi thoát mini player, cuộn lên bài hát đang phát
    if (!document.body.classList.contains('mini-player-active')) {
        setTimeout(renderQueue, 100);
    }
}

// KHỞI TẠO ÂM THANH - ĐÃ XỬ LÝ CORS CẤP TRÌNH DUYỆT BẰNG THẺ AUDIO
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
  audReady = true; applyEQToFilters(); if (S.spectrum) startSpec();
}

function buildEQSliders() {
  const row = document.getElementById('eq-row'); row.innerHTML = '';
  for (let i = 0; i < 6; i++) {
    const band = document.createElement('div'); band.className = 'eq-band';
    const db = document.createElement('div'); db.className = 'dbval'; db.id = `eqdb-${i}`; db.textContent = fmtDb(S.eq[i]);
    const wrap = document.createElement('div'); wrap.className = 'sl-vert-wrap';
    const sl = document.createElement('input'); sl.type = 'range'; sl.className = 'sl-vert';
    sl.min = -12; sl.max = 12; sl.step = 1; sl.value = S.eq[i]; sl.id = `eqsl-${i}`;
    const idx = i;
    sl.addEventListener('input', () => { S.eq[idx] = +sl.value; db.textContent = fmtDb(S.eq[idx]); if (eqFilters[idx]) eqFilters[idx].gain.value = S.eq[idx]; drawEQ(); saveStateToBrowser(); });
    const lbl = document.createElement('div'); lbl.className = 'eqlbl'; lbl.textContent = EQ_LABELS[i];
    wrap.appendChild(sl); band.appendChild(db); band.appendChild(wrap); band.appendChild(lbl); row.appendChild(band);
  }
  drawEQ();
}

function applyEQToFilters() {
  for (let i = 0; i < 6; i++) {
    if (eqFilters[i]) eqFilters[i].gain.value = S.eq[i];
    const sl = document.getElementById(`eqsl-${i}`);
    if (sl) { sl.value = S.eq[i]; document.getElementById(`eqdb-${i}`).textContent = fmtDb(S.eq[i]); }
  }
}

function drawEQ() {
  const cv = document.getElementById('eq-canvas'); const W = cv.clientWidth || cv.offsetWidth || 600; cv.width = W; const H = cv.height; const ctx = cv.getContext('2d');
  ctx.fillStyle = '#1e2a35'; ctx.fillRect(0, 0, W, H);
  for (let db = -12; db <= 12; db += 3) {
    const y = H/2 - (db/12) * (H/2 - 14); ctx.strokeStyle = db === 0 ? 'rgba(255,255,255,.18)' : 'rgba(255,255,255,.07)'; ctx.lineWidth = db === 0 ? 1.5 : 1;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    if (db !== 0 && db % 6 === 0) { ctx.fillStyle = 'rgba(255,255,255,.25)'; ctx.font = '10px Exo 2,sans-serif'; ctx.fillText(db+'dB', 4, y - 2); }
  }
  for (let i = 0; i < 6; i++) { const x = ((i + .5) / 6) * W; ctx.strokeStyle = 'rgba(255,255,255,.06)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  const pts = []; for (let i = 0; i < 6; i++) pts.push({ x: ((i+.5)/6)*W, y: H/2 - (S.eq[i]/12)*(H/2-14) });
  const grad = ctx.createLinearGradient(0, 0, 0, H); grad.addColorStop(0, 'rgba(66,147,245,.35)'); grad.addColorStop(1, 'rgba(66,147,245,.04)');
  ctx.beginPath(); ctx.moveTo(0, H/2); ctx.lineTo(pts[0].x, pts[0].y);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(i-1,0)], p1 = pts[i], p2 = pts[i+1], p3 = pts[Math.min(i+2,pts.length-1)];
    const cp1x = p1.x + (p2.x - p0.x)/6, cp1y = p1.y + (p2.y - p0.y)/6; const cp2x = p2.x - (p3.x - p1.x)/6, cp2y = p2.y - (p3.y - p1.y)/6;
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
  }
  ctx.lineTo(W, H/2); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
  ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(i-1,0)], p1 = pts[i], p2 = pts[i+1], p3 = pts[Math.min(i+2,pts.length-1)];
    const cp1x = p1.x + (p2.x - p0.x)/6, cp1y = p1.y + (p2.y - p0.y)/6; const cp2x = p2.x - (p3.x - p1.x)/6, cp2y = p2.y - (p3.y - p1.y)/6;
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
  }
  ctx.strokeStyle = '#4293f5'; ctx.lineWidth = 2.5; ctx.shadowBlur = 10; ctx.shadowColor = '#4293f5'; ctx.stroke(); ctx.shadowBlur = 0;
  for (const p of pts) { ctx.beginPath(); ctx.arc(p.x, p.y, 5.5, 0, Math.PI*2); ctx.fillStyle = '#7db9ff'; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); }
  ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.font = '10.5px Exo 2,sans-serif';
  for (let i = 0; i < 6; i++) ctx.fillText(EQ_LABELS[i], ((i+.5)/6)*W - 12, H - 4);
}

let specRaf = null; let specW = 0;
function startSpec() {
  if (specRaf) return;
  const cv  = document.getElementById('spec-canvas'); const ctx = cv.getContext('2d'); const BARS = 32;
  function frame() {
    if (!S.spectrum) { specRaf = null; return; }
    specRaf = requestAnimationFrame(frame);
    const W = cv.clientWidth || cv.offsetWidth || 600; if (W !== specW) { cv.width = W; specW = W; }
    const H = cv.height; ctx.fillStyle = '#1e2a35'; ctx.fillRect(0, 0, W, H);
    const bw = W / BARS;
    if (!analyser) { for (let i = 0; i < BARS; i++) { ctx.fillStyle = 'rgba(66,147,245,.2)'; ctx.fillRect(i*bw+1, H-3, bw-2, 3); } return; }
    const buf = analyser.frequencyBinCount; const da = new Uint8Array(buf); analyser.getByteFrequencyData(da);
    const step = Math.max(1, Math.floor(buf / BARS));
    for (let i = 0; i < BARS; i++) {
      let sum = 0; for (let j = 0; j < step; j++) sum += da[Math.min(i*step+j, buf-1)];
      const avg = sum / step; const h = Math.max(3, (avg / 255) * (H - 4));
      const gr = ctx.createLinearGradient(0, H, 0, H-h); gr.addColorStop(0, '#1c4f8c'); gr.addColorStop(.55, '#4293f5'); gr.addColorStop(1, '#a0d4ff'); ctx.fillStyle = gr;
      const x = i*bw+1, y = H-h, w2 = bw-2; const r = Math.min(3, w2/2);
      ctx.beginPath(); ctx.moveTo(x+r, y); ctx.lineTo(x+w2-r, y); ctx.quadraticCurveTo(x+w2, y, x+w2, y+r); ctx.lineTo(x+w2, H); ctx.lineTo(x, H); ctx.lineTo(x, y+r); ctx.quadraticCurveTo(x, y, x+r, y); ctx.closePath(); ctx.fill();
    }
  }
  frame();
}

function stopSpec() {
  if (specRaf) { cancelAnimationFrame(specRaf); specRaf = null; }
  const cv = document.getElementById('spec-canvas'); const ctx = cv.getContext('2d');
  ctx.fillStyle = '#1e2a35'; ctx.fillRect(0, 0, cv.clientWidth || 600, cv.height);
}

function toggleSpectrum(on) { S.spectrum = on; if (on) startSpec(); else stopSpec(); saveStateToBrowser(); }

function setTitle(name) { document.getElementById('song-title').innerHTML = `<span class="dot"></span>${name}`; }

function renderQueue() {
  const el = document.getElementById('queue-wrap'); el.innerHTML = '';
  for (let i = 0; i < S.queue.length; i++) {
    const n = S.queue[i], cnt = S.counts[n] || 0;
    const d = document.createElement('div'); d.className = 'qitem' + (i === S.idx ? ' now' : '');
    d.innerHTML = `<span>${i===S.idx?'▶️':'🎵'}</span><span class="qname">${n}</span><span class="qcnt">🎧 x${cnt}</span>`;
    const ci = i; d.addEventListener('dblclick', () => { S.savedTime = 0; playTrack(ci, false); });
    el.appendChild(d);
  }
  const playing = el.querySelector('.now'); if (playing && !document.body.classList.contains('mini-player-active')) setTimeout(() => playing.scrollIntoView({behavior:'smooth',block:'nearest'}), 80);
}

function renderGrid() {
  const g = document.getElementById('pgrid'); if (!S.playlist.length) return; g.innerHTML = '';
  const curName = S.queue[S.idx];
  for (const song of S.playlist) {
    const cnt = S.counts[song.name] || 0, now = song.name === curName, d = document.createElement('div'); d.className = 'scard' + (now ? ' now' : '');
    d.innerHTML = `<div class="cico">${now?'🎵':'🎶'}</div><div class="cname">${song.name}</div><div class="ccnt">🎧 x${cnt}</div>`;
    const nm = song.name;
    d.addEventListener('dblclick', () => {
      const qi = S.queue.indexOf(nm); S.savedTime = 0;
      if (qi !== -1) playTrack(qi, false); else { S.queue.splice(S.idx, 0, nm); playTrack(S.idx, false); }
    });
    g.appendChild(d);
  }
}

function applyUI() {
  document.getElementById('vol-sl').value = S.volume; document.getElementById('vol-lbl').textContent = S.volume + '%';
  document.getElementById('btn-mode').textContent = S.random ? 'Chế độ: Ngẫu nhiên' : 'Chế độ: Tuần tự';
  document.getElementById('spec-chk').checked = S.spectrum;
  applyEQToFilters(); drawEQ(); renderQueue(); renderGrid();
  if (S.spectrum) setTimeout(startSpec, 400); if (S.queue[S.idx]) setTitle(S.queue[S.idx]);
}

function tickUI() { document.getElementById('btn-play').textContent = aud.paused ? '▶ Play / Tạm dừng' : '⏸ Tạm dừng (Fade Out)'; }

function hookTabs() {
  const tabs = ['control','eq','spectrum','playlist'];
  document.querySelectorAll('.tabbar button').forEach((btn, i) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tabbar button').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('on'));
      btn.classList.add('active'); document.getElementById('tab-' + tabs[i]).classList.add('on');
      if (tabs[i] === 'eq') setTimeout(drawEQ, 50); if (tabs[i] === 'spectrum' && S.spectrum) startSpec();
    });
  });
}

function fmt(sec) {
  if (!sec || isNaN(sec)) return '00:00'; sec = Math.max(0, Math.floor(sec));
  return String(Math.floor(sec/60)).padStart(2,'0') + ':' + String(sec%60).padStart(2,'0');
}
function fmtDb(v) { return (v >= 0 ? '+' : '') + v + 'dB'; }
function setStatus(msg) { document.getElementById('statusbar').textContent = msg; }
function hideLoader() { document.getElementById('loader').style.display = 'none'; }
window.addEventListener('resize', drawEQ);

init();
