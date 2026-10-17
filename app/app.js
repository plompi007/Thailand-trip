'use strict';

const TZ = 'Asia/Bangkok';
const CAT_ICON = {
  hotel: '🏨', beach: '🏖️', nature: '🌿', waterfall: '💧', viewpoint: '⛰️', wildlife: '🐢',
  market: '🛍️', food: '🍜', cafe: '☕', culture: '🏛️', shopping: '🛒', medical: '🏥', transport: '✈️',
};
// Places the "what now" picker never suggests.
const NOT_SUGGESTED = new Set(['hotel', 'medical', 'transport']);
// How well each category fits each part of the day (0 = skip).
const SLOT_WEIGHTS = {
  morning:   { nature: 3, waterfall: 3, wildlife: 3, beach: 2, viewpoint: 2, market: 1, culture: 1, cafe: 1 },
  midday:    { food: 3, cafe: 3, culture: 2, shopping: 2, wildlife: 1 },
  afternoon: { beach: 3, viewpoint: 2, market: 2, nature: 1, cafe: 1, waterfall: 1 },
  evening:   { food: 3, market: 3, viewpoint: 1 },
  night:     { food: 2, market: 1 },
};
const SLOT_TITLE = {
  morning: '☀️ בוקר: זמן טוב לטבע, לפני החום',
  midday: '🌤️ צהריים: אוכל, מזגן ומנוחה',
  afternoon: '🌅 אחר הצהריים: חוף ושקיעה',
  evening: '🌙 ערב: שווקים וארוחת ערב',
  night: '🌙 לילה: אולי פשוט לישון 😴',
};
// Booked stays: used to pick a default "base" by date when GPS isn't available.
const STAYS = [
  { id: 'naiyang-park-resort', from: '2026-10-28', to: '2026-10-30', label: 'נאי יאנג' },
  { id: 'jasmin-resort', from: '2026-11-01', to: '2026-11-08', label: 'קאו לאק' },
  { id: 'krabi-villa', from: '2026-11-11', to: '2026-11-17', label: 'קראבי' },
];
const MAX_SUGGEST_KM = 60;
// Straight-line distance lies across the bays (Krabi↔Phuket is ~45 km by air, 3 h by road),
// so suggestions stay within the region you're in, plus anything really close.
const REGION_GROUP = { 'phuket-north': 'phuket', phuket: 'phuket', khaolak: 'khaolak', phangnga: 'phangnga', khaosok: 'khaosok', krabi: 'krabi' };
const NEAR_ANY_REGION_KM = 25;
const NOA_CATS = new Set(['wildlife', 'nature', 'waterfall', 'beach', 'viewpoint']);

const state = {
  data: null,
  places: [],
  cat: 'all',
  babyOnly: load('babyOnly', false),
  visited: new Set(load('visited', [])),
  origin: null,          // {lat, lon, label, kind: 'gps'|'base'}
  originChoice: load('originChoice', 'auto'),
  gpsWatch: null,
  view: 'map',
  shuffleSeed: 0,
};

function load(key, fallback) {
  try { const v = localStorage.getItem('th.' + key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem('th.' + key, JSON.stringify(value)); } catch { /* private mode etc. */ }
}
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- time & opening hours (always Thai time) ----------
function thaiNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const hour = Number(parts.hour), minute = Number(parts.minute);
  return { day, hour, minute, minOfWeek: day * 1440 + hour * 60 + minute, date: `${parts.year}-${parts.month}-${parts.day}` };
}
const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(2));
const fmt = (hhmm) => `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`;

// Returns {status: 'open'|'closed'|'unknown', until?, opensAt?, today: ["10:00–23:00", ...]}
function hoursInfo(p, now) {
  const periods = p.geo && p.geo.periods;
  if (!periods || !periods.length) return { status: 'unknown', today: [] };
  const WEEK = 10080;
  let status = 'closed', until = null, opensAt = null;
  const today = [];
  for (const [od, ot, cd, ct] of periods) {
    const o = od * 1440 + toMin(ot);
    let c = cd * 1440 + toMin(ct);
    if (c <= o) c += WEEK;
    for (const m of [now.minOfWeek, now.minOfWeek + WEEK]) {
      if (m >= o && m < c) { status = 'open'; until = ct; }
    }
    if (od === now.day) {
      today.push(`${fmt(ot)}–${fmt(ct)}`);
      if (o > now.minOfWeek && (opensAt === null || o < opensAt.min)) opensAt = { min: o, t: ot };
    }
  }
  if (ot24(periods)) return { status: 'unknown', allDay: true, today: [] };
  return { status, until, opensAt: opensAt && opensAt.t, today };
}
const ot24 = (periods) => periods.length === 1 && periods[0][1] === '0000' && periods[0][3] === '2400';

function hoursLine(h) {
  if (h.status === 'open') return `<span class="open">פתוח עכשיו${h.until ? ' עד ' + fmt(h.until) : ''}</span>`;
  if (h.status === 'closed') {
    if (h.opensAt) return `<span class="soon">נפתח היום ב-${fmt(h.opensAt)}</span>`;
    return '<span class="closed">סגור היום</span>';
  }
  return '';
}

function slotFor(now) {
  const h = now.hour;
  if (h >= 6 && h < 11) return 'morning';
  if (h >= 11 && h < 15) return 'midday';
  if (h >= 15 && h < 18) return 'afternoon';
  if (h >= 18 && h < 22) return 'evening';
  return 'night';
}

// ---------- distance ----------
function km(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
// Rough drive time: winding roads, ~1.4x straight line at ~45 km/h.
const driveMin = (d) => Math.round((d * 1.4) / 45 * 60 + 3);
function distLabel(p) {
  if (!state.origin) return '';
  const d = km(state.origin, p);
  if (d < 1) return `${Math.round(d * 1000)} מ' ממך`;
  return `${d < 10 ? d.toFixed(1) : Math.round(d)} ק"מ · ~${driveMin(d)} דק' נסיעה`;
}

// ---------- filtering ----------
function visiblePlaces() {
  return state.places.filter((p) =>
    (state.cat === 'all' || p.category === state.cat || (state.cat === 'food' && p.category === 'cafe')) && (!state.babyOnly || p.baby >= 3 || p.category === 'hotel'));
}

// ---------- origin (GPS or booked base) ----------
function stayForDate(date) {
  return STAYS.find((s) => date >= s.from && date <= s.to);
}
function baseOrigin(id, label) {
  const p = state.places.find((x) => x.id === id);
  return p && { lat: p.lat, lon: p.lon, label, kind: 'base' };
}
function resolveOrigin() {
  const choice = state.originChoice;
  stopGps();
  if (choice === 'gps' || choice === 'auto') {
    if (choice === 'auto') {
      const stay = stayForDate(thaiNow().date);
      state.origin = stay ? baseOrigin(stay.id, stay.label) : null;
    }
    startGps();
  } else {
    const stay = STAYS.find((s) => s.id === choice);
    state.origin = stay ? baseOrigin(stay.id, stay.label) : null;
  }
  renderAll();
}
function startGps() {
  if (!('geolocation' in navigator)) return;
  state.gpsWatch = navigator.geolocation.watchPosition((pos) => {
    state.origin = { lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'אני כאן', kind: 'gps' };
    updateMe();
    renderLists();
    renderLocLabel();
  }, () => { /* denied/unavailable: keep base fallback */ }, { enableHighAccuracy: true, maximumAge: 60000, timeout: 20000 });
}
function stopGps() {
  if (state.gpsWatch !== null) navigator.geolocation.clearWatch(state.gpsWatch);
  state.gpsWatch = null;
}
function renderLocLabel() {
  $('#locLabel').textContent = state.origin ? state.origin.label : 'מיקום';
}
function openLocMenu() {
  const opts = [
    ['auto', '✨ אוטומטי (GPS, ואם אין, לפי המלון של היום)'],
    ['gps', '🛰️ רק GPS'],
    ...STAYS.map((s) => [s.id, `🏨 ${s.label} (${s.from.slice(8)}.${s.from.slice(5, 7)}–${s.to.slice(8)}.${s.to.slice(5, 7)})`]),
  ];
  $('#locOptions').innerHTML = opts.map(([v, l]) =>
    `<button class="btn ${state.originChoice === v ? 'primary' : ''}" data-v="${v}" type="button">${esc(l)}</button>`).join('');
  $('#locMenu').hidden = false;
}

// ---------- map ----------
let map, markerLayer, meMarker;
function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: true }).setView([8.35, 98.5], 9);
  const esri = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
  const satellite = L.layerGroup([
    L.tileLayer(esri + 'World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' }),
    // Place names and roads on top of the photo.
    L.tileLayer(esri + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18 }),
    L.tileLayer(esri + 'Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18 }),
  ]);
  const streets = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' });
  const layers = { '🛰️ תצלום אוויר': satellite, '🗺️ מפה רגילה': streets };
  const saved = load('baseLayer', '🛰️ תצלום אוויר');
  (layers[saved] || satellite).addTo(map);
  map.on('baselayerchange', (e) => save('baseLayer', e.name));
  L.control.layers(layers, null, { position: 'topleft' }).addTo(map);
  L.control.zoom({ position: 'bottomleft' }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
}
function renderMap() {
  markerLayer.clearLayers();
  for (const p of visiblePlaces()) {
    const cls = ['pin', p.category === 'hotel' ? 'hotel' : '', state.visited.has(p.id) ? 'visited' : ''].join(' ');
    L.marker([p.lat, p.lon], {
      icon: L.divIcon({ className: '', html: `<div class="${cls}">${CAT_ICON[p.category] || '📍'}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] }),
      title: p.name_he,
    }).on('click', () => openPlace(p.id)).addTo(markerLayer);
  }
}
function updateMe() {
  if (!map || !state.origin || state.origin.kind !== 'gps') { if (meMarker) { meMarker.remove(); meMarker = null; } return; }
  const ll = [state.origin.lat, state.origin.lon];
  if (!meMarker) meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [16, 16] }), interactive: false }).addTo(map);
  else meMarker.setLatLng(ll);
}

// ---------- lists ----------
function itemHtml(p, why) {
  const now = thaiNow();
  const h = hoursInfo(p, now);
  const sub = [distLabel(p), hoursLine(h)].filter(Boolean).join(' · ');
  return `<li class="item ${state.visited.has(p.id) ? 'visited' : ''}" data-id="${p.id}">
    <div class="ico">${CAT_ICON[p.category] || '📍'}</div>
    <div class="body">
      <div class="name">${esc(p.name_he)}${state.visited.has(p.id) ? ' ✓' : ''}</div>
      <div class="sub">${sub || esc(state.data.meta.regions[p.region])}</div>
      ${why ? `<div class="why">${why}</div>` : ''}
    </div></li>`;
}
function renderNearby() {
  let items = visiblePlaces();
  if (state.origin) items = items.map((p) => [p, km(state.origin, p)]).sort((a, b) => a[1] - b[1]).map(([p]) => p);
  $('#list').innerHTML = items.length ? items.map((p) => itemHtml(p)).join('') : '<li class="empty">אין מקומות בסינון הזה</li>';
}

// Small deterministic PRNG so "shuffle" gives a new but stable set.
function rand(seed) { let t = seed + 0x6d2b79f5; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }

function suggestions() {
  const now = thaiNow();
  const slot = slotFor(now);
  const weights = SLOT_WEIGHTS[slot];
  const scored = [];
  let originGroup = null;
  if (state.origin) {
    let best = Infinity;
    for (const p of state.places) { const dd = km(state.origin, p); if (dd < best) { best = dd; originGroup = REGION_GROUP[p.region]; } }
  }
  for (const p of visiblePlaces()) {
    if (NOT_SUGGESTED.has(p.category)) continue;
    let score = weights[p.category] || 0;
    // Breakfast spots (dim sum, khanom jeen, roti) belong to the morning.
    if (p.meal === 'breakfast') score = slot === 'morning' ? 3 : Math.min(score, 1);
    if (!score) continue;
    const reasons = [];
    const h = hoursInfo(p, now);
    if (h.status === 'closed' && !(h.opensAt && toMin(h.opensAt) - (now.hour * 60 + now.minute) <= 90)) continue;
    if (h.status === 'open') { score += 1; if (p.category === 'market') { score += 2; reasons.push('🛍️ השוק פתוח היום'); } }
    if (h.status === 'closed' && h.opensAt) reasons.push(`נפתח ב-${fmt(h.opensAt)}`);
    if (h.status === 'unknown' && p.category === 'market' && p.days === 'כל יום') score += 2;
    if (state.origin) {
      const d = km(state.origin, p);
      if (d > MAX_SUGGEST_KM) continue;
      if (REGION_GROUP[p.region] !== originGroup && d > NEAR_ANY_REGION_KM) continue;
      score -= d / 15;
    }
    if (p.tip_he.includes('⭐')) { score += 0.7; if (NOA_CATS.has(p.category)) reasons.push('⭐ במיוחד בשביל נועה'); }
    if (p.rec && p.rec.includes('מישלן')) { score += 0.5; reasons.push('🎖️ ' + p.rec); }
    if (p.vibe === 'local') { score += 0.7; if (p.category === 'food' || p.category === 'cafe') reasons.push('🇹🇭 מקומי ואותנטי'); }
    if (p.vibe === 'mixed') score -= 1;
    if (p.meal === 'breakfast' && slot === 'morning') reasons.push('🍳 ארוחת בוקר מקומית');
    if (p.baby >= 3) score += 0.5;
    if (state.visited.has(p.id)) score -= 2.5;
    score += rand(hash(p.id) ^ state.shuffleSeed) * 1.6;
    scored.push({ p, score, reasons });
  }
  scored.sort((a, b) => b.score - a.score);
  // Prefer variety: at most one per category in the top 3.
  const picked = [], seen = new Set();
  for (const s of scored) {
    if (seen.has(s.p.category)) continue;
    picked.push(s); seen.add(s.p.category);
    if (picked.length === 3) break;
  }
  return { slot, picked };
}
function renderNow() {
  const { slot, picked } = suggestions();
  $('#nowTitle').textContent = SLOT_TITLE[slot];
  $('#nowList').innerHTML = picked.length
    ? picked.map(({ p, reasons }) => itemHtml(p, [esc(firstSentence(p.tip_he).replace(/^⭐\s*/, '')), ...reasons].join('<br>'))).join('')
    : `<li class="empty">${state.origin ? 'לא מצאתי משהו פתוח וקרוב עכשיו. אפשר לנסות "הצעות אחרות" או להוריד את הסינון.' : 'בחרו מיקום (📍 למעלה) כדי לקבל הצעות קרובות'}</li>`;
}
const firstSentence = (s) => s.split(/(?<=[.!])\s/)[0];

// ---------- place sheet ----------
function openPlace(id) {
  const p = state.places.find((x) => x.id === id);
  if (!p) return;
  const now = thaiNow();
  const h = hoursInfo(p, now);
  const g = p.geo || {};
  const babyTxt = { 3: '👶 קל עם נאם', 2: '👶 אפשרי עם מנשא', 1: '💪 מאמץ / להתפצל' }[p.baby];
  const gmaps = `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lon}${g.place_id ? '&query_place_id=' + g.place_id : ''}`;
  const waze = `https://waze.com/ul?ll=${p.lat},${p.lon}&navigate=yes`;
  const visited = state.visited.has(p.id);
  $('#sheetBody').innerHTML = `
    <h2>${CAT_ICON[p.category] || ''} ${esc(p.name_he)}</h2>
    <div class="en">${esc(p.name)}</div>
    <div style="margin-top:8px">
      <span class="badge">${esc(state.data.meta.categories[p.category])}</span>
      <span class="badge">${babyTxt}</span>
      ${p.rec && !p.rec.startsWith('Google') ? `<span class="badge">🎖️ ${esc(p.rec)}</span>` : ''}
      ${p.vibe ? `<span class="badge">${esc(state.data.meta.vibe[p.vibe])}</span>` : ''}
      ${p.meal === 'breakfast' ? '<span class="badge">🍳 ארוחת בוקר</span>' : ''}
      ${g.rating ? `<span class="badge">★ ${g.rating} (${g.reviews || 0})</span>` : ''}
    </div>
    <p class="tip">${esc(p.tip_he)}</p>
    <div class="meta">
      ${distLabel(p) ? `<div>📏 ${distLabel(p)}</div>` : ''}
      ${hoursLine(h) ? `<div>🕒 ${hoursLine(h)}${h.today.length ? ` · היום: ${h.today.join(', ')}` : ''}</div>` : ''}
      ${p.days || p.hours ? `<div>📅 ${g.periods ? 'לפי מדריכים: ' : ''}${esc([p.days, p.hours].filter(Boolean).join(' · '))}</div>` : ''}
      ${p.dates ? `<div>🛏️ ${esc(p.dates)}</div>` : ''}
      ${p.cost ? `<div>💰 ${esc(p.cost)}</div>` : ''}
      ${g.business_status && g.business_status !== 'OPERATIONAL' ? '<div class="closed">⚠️ לפי גוגל: סגור זמנית</div>' : ''}
    </div>
    <div class="actions">
      <a class="btn primary" href="${gmaps}" target="_blank" rel="noopener">🧭 גוגל מפות</a>
      <a class="btn" href="${waze}" target="_blank" rel="noopener">🚗 Waze</a>
      <button class="btn" type="button" data-visit="${p.id}">${visited ? '↩️ לא היינו' : '✓ היינו כאן'}</button>
      <button class="btn ghost" type="button" data-fly="${p.id}">🗺️ במפה</button>
    </div>`;
  $('#sheet').hidden = false;
}

// ---------- rendering & events ----------
function renderCats() {
  const counts = {};
  for (const p of state.places) counts[p.category] = (counts[p.category] || 0) + 1;
  // Most-used first; cafés are shown under restaurants.
  const order = ['food', 'beach', 'nature', 'waterfall', 'viewpoint', 'wildlife', 'market', 'culture', 'hotel', 'shopping', 'medical', 'transport'];
  const cats = ['all', ...order.filter((c) => counts[c])];
  $('#cats').innerHTML = cats.map((c) => {
    const label = c === 'all' ? 'הכל' : c === 'food' ? '🍜 מסעדות' : `${CAT_ICON[c]} ${state.data.meta.categories[c]}`;
    return `<button class="chip ${state.cat === c ? 'on' : ''}" data-cat="${c}" type="button">${label}</button>`;
  }).join('');
}
function renderLists() {
  if (state.view === 'list') renderNearby();
  if (state.view === 'now') renderNow();
}
function renderAll() {
  renderLocLabel();
  $('#babyBtn').setAttribute('aria-pressed', String(state.babyOnly));
  renderCats();
  renderMap();
  updateMe();
  renderLists();
}
function setView(v) {
  state.view = v;
  document.querySelectorAll('.view').forEach((el) => el.classList.toggle('active', el.id === 'view-' + v));
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  if (v === 'map') setTimeout(() => map.invalidateSize(), 0);
  renderLists();
}

function bind() {
  document.querySelector('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]'); if (b) setView(b.dataset.view);
  });
  $('#cats').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]'); if (!b) return;
    state.cat = b.dataset.cat; renderAll();
  });
  $('#babyBtn').addEventListener('click', () => { state.babyOnly = !state.babyOnly; save('babyOnly', state.babyOnly); renderAll(); });
  $('#locBtn').addEventListener('click', openLocMenu);
  $('#locOptions').addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]'); if (!b) return;
    state.originChoice = b.dataset.v; save('originChoice', state.originChoice);
    $('#locMenu').hidden = true; resolveOrigin();
  });
  for (const list of ['#list', '#nowList']) {
    $(list).addEventListener('click', (e) => { const li = e.target.closest('[data-id]'); if (li) openPlace(li.dataset.id); });
  }
  $('#shuffleBtn').addEventListener('click', () => { state.shuffleSeed = (state.shuffleSeed + 1) * 7919; renderNow(); });
  const closeSheets = (e) => {
    if (e.target.matches('.sheet') || e.target.closest('.close')) e.target.closest('.sheet').hidden = true;
  };
  $('#sheet').addEventListener('click', closeSheets);
  $('#locMenu').addEventListener('click', closeSheets);
  $('#sheetBody').addEventListener('click', (e) => {
    const v = e.target.closest('[data-visit]');
    if (v) {
      const id = v.dataset.visit;
      state.visited.has(id) ? state.visited.delete(id) : state.visited.add(id);
      save('visited', [...state.visited]);
      openPlace(id); renderMap(); renderLists();
    }
    const f = e.target.closest('[data-fly]');
    if (f) {
      const p = state.places.find((x) => x.id === f.dataset.fly);
      $('#sheet').hidden = true; setView('map'); map.setView([p.lat, p.lon], 15);
    }
  });
  const net = () => { $('#offline').hidden = navigator.onLine; };
  addEventListener('online', net); addEventListener('offline', net); net();
  // Re-evaluate "open now" and time-of-day every few minutes.
  setInterval(renderLists, 5 * 60 * 1000);
}

async function start() {
  const res = await fetch('data/places.json');
  state.data = await res.json();
  state.places = state.data.places;
  initMap();
  bind();
  resolveOrigin();
  const stay = stayForDate(thaiNow().date);
  if (stay) { const p = state.places.find((x) => x.id === stay.id); map.setView([p.lat, p.lon], 11); }
  if ('serviceWorker' in navigator) {
    // When a new version takes over, reload once so the new app and data show up right away.
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) location.reload(); });
    navigator.serviceWorker.register('sw.js').then((reg) => reg.update()).catch(() => {});
  }
}
start();
