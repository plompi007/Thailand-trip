'use strict';

const TZ = 'Asia/Bangkok';
const CAT_ICON = {
  hotel: '🏨', beach: '🏖️', nature: '🌿', waterfall: '💧', viewpoint: '⛰️', wildlife: '🐢',
  market: '🛍️', food: '🍜', cafe: '☕', culture: '🏛️', shopping: '🛒', medical: '🏥', transport: '✈️',
};
const CAT_COLOR = {
  food: '#e76f51', cafe: '#e76f51', beach: '#0ea5e9', nature: '#16a34a', waterfall: '#0891b2', viewpoint: '#7c3aed',
  wildlife: '#65a30d', market: '#db2777', culture: '#b45309', shopping: '#64748b', medical: '#dc2626', transport: '#475569', hotel: '#4f46e5',
};
// Category chips, most-used first; cafés are shown under restaurants.
const CAT_ORDER = ['food', 'beach', 'nature', 'waterfall', 'viewpoint', 'wildlife', 'market', 'culture', 'hotel', 'shopping', 'medical', 'transport'];
const CAT_SHORT = { food: 'מסעדות', beach: 'חופים', nature: 'טבע', waterfall: 'מפלים', viewpoint: 'תצפיות', wildlife: 'חיות', market: 'שווקים', culture: 'תרבות', hotel: 'לינה', shopping: 'קניות', medical: 'רפואה', transport: 'תחבורה' };
// Quick-jump areas: [center, zoom].
const AREAS = {
  all: { label: 'כל האזורים', view: [[8.3, 98.6], 9] },
  'phuket-north': { label: 'צפון פוקט', view: [[8.09, 98.31], 12] },
  phuket: { label: 'פוקט – מרכז ודרום', view: [[7.86, 98.35], 11] },
  khaolak: { label: 'קאו לאק', view: [[8.68, 98.26], 11] },
  phangnga: { label: 'פנג נגה', view: [[8.42, 98.52], 10] },
  khaosok: { label: 'קאו סוק', view: [[8.91, 98.6], 11] },
  krabi: { label: 'קראבי', view: [[8.07, 98.84], 11] },
  lanta: { label: 'קו לנטה', view: [[7.57, 99.06], 11] },
};
// Places the "what now" picker never suggests.
const NOT_SUGGESTED = new Set(['hotel', 'medical', 'transport', 'shopping']);
// How well each category fits each part of the day (0 = skip).
const SLOT_WEIGHTS = {
  morning:   { nature: 3, waterfall: 3, wildlife: 3, beach: 2, viewpoint: 2, market: 1, culture: 1, cafe: 1 },
  midday:    { food: 3, cafe: 3, culture: 2, wildlife: 1 },
  afternoon: { beach: 3, viewpoint: 2, market: 2, nature: 1, cafe: 1, waterfall: 1 },
  evening:   { food: 3, market: 3, viewpoint: 1 },
  night:     { food: 2, market: 1 },
};
const SLOT_TITLE = {
  morning: '☀️ בוקר: טבע, לפני החום',
  midday: '🌤️ צהריים: אוכל, מזגן ומנוחה',
  afternoon: '🌅 אחר הצהריים: חוף ושקיעה',
  evening: '🌙 ערב: שווקים וארוחת ערב',
  night: '🌙 לילה: אולי פשוט לישון 😴',
};
// Booked stays: used to pick a default "base" by date when GPS isn't available.
const STAYS = [
  { id: 'naiyang-park-resort', from: '2026-10-28', to: '2026-10-30', label: 'המלון בנאי יאנג' },
  { id: 'jasmin-resort', from: '2026-11-01', to: '2026-11-08', label: 'המלון בקאו לאק' },
  { id: 'krabi-villa', from: '2026-11-11', to: '2026-11-17', label: 'הווילה בקראבי' },
];
const MAX_SUGGEST_KM = 60;
// Straight-line distance lies across the bays (Krabi↔Phuket is ~45 km by air, 3 h by road),
// so suggestions stay within the region you're in, plus anything really close.
const REGION_GROUP = { 'phuket-north': 'phuket', phuket: 'phuket', khaolak: 'khaolak', phangnga: 'phangnga', khaosok: 'khaosok', krabi: 'krabi', lanta: 'lanta' };
const NEAR_ANY_REGION_KM = 25;
const NOA_CATS = new Set(['wildlife', 'nature', 'waterfall', 'beach', 'viewpoint']);
const LABEL_ZOOM = 14;

const state = {
  data: null,
  places: [],
  byId: new Map(),
  cat: 'all',
  area: load('area', 'all'),
  query: '',
  babyOnly: load('babyOnly', false),
  visited: new Set(load('visited', [])),
  favs: new Set(load('favs', [])),
  origin: null,          // {lat, lon, label, kind: 'gps'|'base'}
  originChoice: load('originChoice', 'auto'),
  gpsWatch: null,
  view: 'map',
  dishes: null,
  dictTag: 'all',
  dictQuery: '',
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
const ot24 = (periods) => periods.length === 1 && periods[0][1] === '0000' && periods[0][3] === '2400';

// Returns {status: 'open'|'closed'|'unknown', until?, opensAt?, today: ["10:00–23:00", ...]}
function hoursInfo(p, now) {
  const periods = p.geo && p.geo.periods;
  if (!periods || !periods.length) return { status: 'unknown', today: [] };
  if (ot24(periods)) return { status: 'unknown', allDay: true, today: [] };
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
  return { status, until, opensAt: opensAt && opensAt.t, today };
}
function hoursLine(h) {
  if (h.status === 'open') return `<span class="open">פתוח${h.until ? ' עד ' + fmt(h.until) : ' עכשיו'}</span>`;
  if (h.status === 'closed') {
    if (h.opensAt) return `<span class="soon">נפתח ב-${fmt(h.opensAt)}</span>`;
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
  if (d < 1) return `${Math.round(d * 1000)} מ'`;
  const m = driveMin(d);
  return `${d < 10 ? d.toFixed(1) : Math.round(d)} ק"מ · ${m < 60 ? `~${m} דק'` : `~${(m / 60).toFixed(1).replace('.0', '')} שע'`}`;
}

// ---------- filtering ----------
function matchesCat(p) {
  if (state.cat === 'all') return true;
  if (state.cat === 'fav') return state.favs.has(p.id);
  return p.category === state.cat || (state.cat === 'food' && p.category === 'cafe');
}
function visiblePlaces({ ignoreArea = false } = {}) {
  return state.places.filter((p) => matchesCat(p) &&
    (!state.babyOnly || p.baby >= 3 || p.category === 'hotel') &&
    (ignoreArea || state.area === 'all' || p.region === state.area));
}

// ---------- origin (GPS or booked base) ----------
function stayForDate(date) {
  return STAYS.find((s) => date >= s.from && date <= s.to);
}
function baseOrigin(id, label) {
  const p = state.byId.get(id);
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
    state.origin = { lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'המיקום שלי', kind: 'gps' };
    updateMe();
    renderLists();
  }, () => { /* denied/unavailable: keep base fallback */ }, { enableHighAccuracy: true, maximumAge: 60000, timeout: 20000 });
}
function stopGps() {
  if (state.gpsWatch !== null) navigator.geolocation.clearWatch(state.gpsWatch);
  state.gpsWatch = null;
}
function originHtml() {
  return state.origin
    ? `📍 מרחקים מ<b>${esc(state.origin.label)}</b> · שינוי`
    : '📍 <b>בחרו נקודת מוצא</b> כדי לראות מרחקים';
}

// ---------- map ----------
let map, cluster, meMarker;
function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: true });
  const esri = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
  const satellite = L.layerGroup([
    L.tileLayer(esri + 'World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18, attribution: 'Imagery © Esri, Maxar' }),
    // English place names and roads on top of the photo.
    L.tileLayer(esri + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18 }),
    L.tileLayer(esri + 'Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18 }),
  ]);
  // Esri's street map has English labels (OpenStreetMap shows Thai script here).
  const streets = L.tileLayer(esri + 'World_Street_Map/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18, attribution: '© Esri, HERE, Garmin' });
  const layers = { '🛰️ תצלום אוויר': satellite, '🗺️ מפה רגילה': streets };
  const saved = load('baseLayer', '🛰️ תצלום אוויר');
  (layers[saved] || satellite).addTo(map);
  map.on('baselayerchange', (e) => save('baseLayer', e.name));
  L.control.layers(layers, null, { position: 'topleft' }).addTo(map);
  L.control.zoom({ position: 'bottomleft' }).addTo(map);
  cluster = L.markerClusterGroup({
    maxClusterRadius: 44, showCoverageOnHover: false, spiderfyOnMaxZoom: true, disableClusteringAtZoom: 15,
    iconCreateFunction: (c) => L.divIcon({ className: '', html: `<div class="cluster">${c.getChildCount()}</div>`, iconSize: [40, 40] }),
  });
  map.addLayer(cluster);
  const syncLabels = () => map.getContainer().classList.toggle('show-labels', map.getZoom() >= LABEL_ZOOM);
  map.on('zoomend', syncLabels);
  const [c, z] = AREAS[state.area].view;
  map.setView(c, z);
  syncLabels();
}
function renderMap() {
  cluster.clearLayers();
  const markers = visiblePlaces({ ignoreArea: true }).map((p) => {
    const cls = ['pin', state.visited.has(p.id) ? 'visited' : '', state.favs.has(p.id) ? 'fav' : ''].join(' ');
    return L.marker([p.lat, p.lon], {
      icon: L.divIcon({ className: '', html: `<div class="${cls}" style="--c:${CAT_COLOR[p.category]}">${CAT_ICON[p.category] || '📍'}</div>`, iconSize: [34, 34], iconAnchor: [17, 17] }),
      title: p.name_he,
    }).bindTooltip(esc(p.name_he), { permanent: true, direction: 'bottom', offset: [0, 14], className: 'pin-label' })
      .on('click', () => openPlace(p.id));
  });
  cluster.addLayers(markers);
}
function updateMe() {
  if (!map || !state.origin || state.origin.kind !== 'gps') { if (meMarker) { meMarker.remove(); meMarker = null; } return; }
  const ll = [state.origin.lat, state.origin.lon];
  if (!meMarker) meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18] }), interactive: false, zIndexOffset: 1000 }).addTo(map);
  else meMarker.setLatLng(ll);
}
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function moveMap(center, zoom) {
  if (reduceMotion()) map.setView(center, zoom, { animate: false });
  else map.flyTo(center, zoom, { duration: 0.6 });
}
function flyToArea(area) {
  const [c, z] = AREAS[area].view;
  moveMap(c, z);
}

// ---------- cards ----------
function navUrl(p) {
  const g = p.geo || {};
  return `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}${g.place_id ? '&destination_place_id=' + g.place_id : ''}`;
}
function tagsHtml(p) {
  const t = [];
  if (p.rec && p.rec.includes('מישלן')) t.push('<span class="tag mich">🎖️ מישלן</span>');
  if (p.vibe === 'local') t.push('<span class="tag local">🇹🇭 מקומי</span>');
  if (p.meal === 'breakfast') t.push('<span class="tag">🍳 בוקר</span>');
  if (p.tip_he.includes('⭐') && NOA_CATS.has(p.category)) t.push('<span class="tag">⭐ לנועה</span>');
  if (p.baby === 1) t.push('<span class="tag">💪 מאמץ</span>');
  return t.join('');
}
function cardHtml(p, why) {
  const h = hoursInfo(p, thaiNow());
  const g = p.geo || {};
  const sub = [distLabel(p), hoursLine(h), g.rating ? `★ ${g.rating}` : ''].filter(Boolean).join(' · ');
  const fav = state.favs.has(p.id);
  return `<li class="card ${state.visited.has(p.id) ? 'visited' : ''}">
    <button class="card-main" type="button" data-id="${p.id}">
      <span class="cat-ico" style="--c:${CAT_COLOR[p.category]}" aria-hidden="true">${CAT_ICON[p.category] || '📍'}</span>
      <span class="body">
        <span class="name">${esc(p.name_he)}${state.visited.has(p.id) ? ' <span aria-label="היינו כאן">✓</span>' : ''}</span>
        <span class="sub">${sub || esc(state.data.meta.regions[p.region])}</span>
        <span class="tags">${tagsHtml(p)}</span>
      </span>
    </button>
    <div class="card-actions">
      <a class="go" href="${navUrl(p)}" target="_blank" rel="noopener" aria-label="ניווט אל ${esc(p.name_he)}"><span aria-hidden="true">🧭</span></a>
      <button class="fav" type="button" data-fav="${p.id}" aria-pressed="${fav}" aria-label="${fav ? 'הסרה מהשמורים' : 'שמירה'}: ${esc(p.name_he)}"><span aria-hidden="true">${fav ? '❤️' : '🤍'}</span></button>
    </div>
    ${why ? `<div class="why">${why}</div>` : ''}
  </li>`;
}
function renderList() {
  const q = state.query.trim().toLowerCase();
  // A search looks everywhere, not only in the chosen area/category.
  let items = q
    ? state.places.filter((p) => [p.name_he, p.name, p.tip_he, p.rec || '', state.data.meta.regions[p.region]].some((f) => f.toLowerCase().includes(q)))
    : visiblePlaces();
  if (state.origin) items = items.map((p) => [p, km(state.origin, p)]).sort((a, b) => a[1] - b[1]).map(([p]) => p);
  $('#originLine').innerHTML = originHtml();
  $('#list').innerHTML = items.length ? items.map((p) => cardHtml(p)).join('')
    : state.cat === 'fav'
      ? emptyHtml('עוד לא שמרתם מקומות. לוחצים 🤍 על מקום כדי לשמור אותו.', 'לכל המקומות', 'clear-filters')
      : emptyHtml(q ? `לא נמצא מקום בשם "${esc(state.query)}"` : 'אין מקומות בסינון הזה', q ? 'ניקוי החיפוש' : 'הסרת הסינון', q ? 'clear-search' : 'clear-filters');
}

// ---------- "what now" ----------
// Small deterministic PRNG so "shuffle" gives a new but stable set.
function rand(seed) { let t = seed + 0x6d2b79f5; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }
// If an area was picked far from where we are, suggest around that area instead.
function suggestOrigin() {
  if (state.area !== 'all') {
    const [[lat, lon]] = AREAS[state.area].view;
    const center = { lat, lon };
    if (!state.origin || km(state.origin, center) > 40) return center;
  }
  return state.origin;
}
function suggestions() {
  const now = thaiNow();
  const slot = slotFor(now);
  const weights = SLOT_WEIGHTS[slot];
  const origin = suggestOrigin();
  let originGroup = null;
  if (origin) {
    let best = Infinity;
    for (const p of state.places) { const dd = km(origin, p); if (dd < best) { best = dd; originGroup = REGION_GROUP[p.region]; } }
  }
  const scored = [];
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
    if (h.status === 'unknown' && p.category === 'market' && p.days === 'כל יום') score += 2;
    if (origin) {
      const d = km(origin, p);
      if (d > MAX_SUGGEST_KM) continue;
      if (REGION_GROUP[p.region] !== originGroup && d > NEAR_ANY_REGION_KM) continue;
      score -= d / 15;
    }
    if (p.tip_he.includes('⭐')) score += 0.7;
    if (p.rec && p.rec.includes('מישלן')) score += 0.5;
    if (p.vibe === 'local') score += 0.7;
    if (p.vibe === 'mixed') score -= 1;
    if (p.meal === 'breakfast' && slot === 'morning') reasons.push('🍳 ארוחת בוקר מקומית');
    if (p.baby >= 3) score += 0.5;
    if (state.favs.has(p.id)) { score += 1; reasons.push('❤️ שמרתם'); }
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
const firstSentence = (s) => s.replace(/^⭐\s*/, '').split(/(?<=[.!:])\s/)[0];
function renderNow() {
  const { slot, picked } = suggestions();
  $('#nowTitle').textContent = SLOT_TITLE[slot];
  $('#originLineNow').innerHTML = state.area !== 'all' && suggestOrigin() !== state.origin
    ? `📍 הצעות באזור <b>${esc(AREAS[state.area].label)}</b>` : originHtml();
  $('#nowList').innerHTML = picked.length
    ? picked.map(({ p, reasons }) => cardHtml(p, esc(firstSentence(p.tip_he)) + (reasons.length ? '<br>' + reasons.map((r) => `<span class="reason">${esc(r)}</span>`).join('') : ''))).join('')
    : suggestOrigin()
      ? emptyHtml('לא מצאתי משהו פתוח וקרוב עכשיו.', 'הסרת הסינון', 'clear-filters')
      : emptyHtml('צריך לדעת איפה אתם כדי להציע משהו קרוב.', 'בחירת אזור', 'area');
}

function emptyHtml(text, action, kind) {
  return `<li class="empty"><p>${text}</p><button class="btn" type="button" data-empty="${kind}">${action}</button></li>`;
}
function handleEmptyAction(kind) {
  if (kind === 'area') { openAreaMenu(); return; }
  if (kind === 'clear-search') { state.query = ''; $('#placeSearch').value = ''; }
  if (kind === 'clear-filters') { state.cat = 'all'; state.babyOnly = false; save('babyOnly', false); state.query = ''; $('#placeSearch').value = ''; }
  renderAll();
}

// ---------- bottom sheet (dialog) ----------
let sheetTrigger = null;
function openSheet(html, label) {
  $('#sheetBody').innerHTML = html;
  const card = $('.sheet-card');
  card.setAttribute('aria-label', label || '');
  card.scrollTop = 0; card.style.transform = '';
  if ($('#sheet').hidden) sheetTrigger = document.activeElement;
  $('#sheet').hidden = false;
  $('#regionBtn').setAttribute('aria-expanded', String(label === 'בחירת אזור'));
  $('.sheet .close').focus({ preventScroll: true });
}
function closeSheet() {
  $('#sheet').hidden = true;
  $('#regionBtn').setAttribute('aria-expanded', 'false');
  if (sheetTrigger && document.contains(sheetTrigger)) sheetTrigger.focus({ preventScroll: true });
  sheetTrigger = null;
}
// Keep keyboard focus inside the open sheet; Escape closes it.
function sheetKeys(e) {
  if ($('#sheet').hidden) return;
  if (e.key === 'Escape') { e.preventDefault(); closeSheet(); return; }
  if (e.key !== 'Tab') return;
  const items = [...$('.sheet-card').querySelectorAll('a[href], button:not([disabled]), input, summary')].filter((el) => el.offsetParent !== null);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
function openPlace(id) {
  const p = state.byId.get(id);
  if (!p) return;
  const h = hoursInfo(p, thaiNow());
  const g = p.geo || {};
  const babyTxt = { 3: '👶 קל עם נאם', 2: '👶 אפשרי עם מנשא', 1: '💪 מאמץ / להתפצל' }[p.baby];
  const waze = `https://waze.com/ul?ll=${p.lat},${p.lon}&navigate=yes`;
  const visited = state.visited.has(p.id), fav = state.favs.has(p.id);
  const status = [hoursLine(h), distLabel(p) && `🚗 ${distLabel(p)}`, g.rating && `★ ${g.rating} (${(g.reviews || 0).toLocaleString('en')})`].filter(Boolean);
  openSheet(`
    <div class="sh-head">
      <div class="cat-ico" style="--c:${CAT_COLOR[p.category]}" aria-hidden="true">${CAT_ICON[p.category] || '📍'}</div>
      <div><h2>${esc(p.name_he)}</h2><div class="en" lang="en">${esc(p.name)}</div></div>
    </div>
    <div class="sh-status">${status.join('<span>·</span>')}</div>
    <div class="sh-actions">
      <a class="btn primary" href="${navUrl(p)}" target="_blank" rel="noopener">🧭 ניווט בגוגל מפות</a>
      <a class="btn" href="${waze}" target="_blank" rel="noopener">🚗 Waze</a>
      <button class="btn ${fav ? 'on' : ''}" type="button" data-fav="${p.id}" aria-pressed="${fav}">${fav ? '❤️ שמור' : '🤍 לשמור'}</button>
    </div>
    <div class="sh-tags">
      <span class="tag">${esc(state.data.meta.categories[p.category])}</span>
      <span class="tag">${babyTxt}</span>
      ${p.rec && p.rec.includes('מישלן') ? `<span class="tag mich">🎖️ ${esc(p.rec)}</span>` : ''}
      ${p.vibe ? `<span class="tag ${p.vibe === 'local' ? 'local' : ''}">${esc(state.data.meta.vibe[p.vibe])}</span>` : ''}
      ${p.meal === 'breakfast' ? '<span class="tag">🍳 ארוחת בוקר</span>' : ''}
    </div>
    <p class="sh-tip">${esc(p.tip_he)}</p>
    <div class="sh-info">
      ${h.today.length ? `<div>🕒 היום: ${h.today.join(', ')}</div>` : ''}
      ${p.days || p.hours ? `<div>📅 ${g.periods ? 'לפי מדריכים: ' : ''}${esc([p.days, p.hours].filter(Boolean).join(' · '))}</div>` : ''}
      ${p.dates ? `<div>🛏️ ${esc(p.dates)}</div>` : ''}
      ${p.cost ? `<div>💰 ${esc(p.cost)}</div>` : ''}
      ${g.business_status && g.business_status !== 'OPERATIONAL' ? '<div class="closed">⚠️ לפי גוגל: סגור זמנית</div>' : ''}
      <div>📍 ${esc(state.data.meta.regions[p.region])}</div>
    </div>
    <div class="sh-actions">
      <button class="btn ${visited ? 'on' : ''}" type="button" data-visit="${p.id}" aria-pressed="${visited}">${visited ? '✓ היינו כאן' : 'סמן שהיינו כאן'}</button>
      <button class="btn" type="button" data-fly="${p.id}">🗺️ הצג במפה</button>
    </div>`, p.name_he);
}
function openAreaMenu() {
  const counts = {};
  for (const p of state.places) counts[p.region] = (counts[p.region] || 0) + 1;
  const opts = Object.entries(AREAS).map(([k, a]) =>
    `<button class="btn ${state.area === k ? 'on' : ''}" type="button" data-area="${k}" aria-pressed="${state.area === k}"><span>${esc(a.label)}</span><small>${k === 'all' ? state.places.length : counts[k] || 0}</small></button>`).join('');
  const origins = [
    ['auto', '✨ אוטומטי: GPS, ואם אין, המלון של היום'],
    ['gps', '🛰️ רק GPS'],
    ...STAYS.map((s) => [s.id, `🏨 ${s.label} (${s.from.slice(8)}.${s.from.slice(5, 7)}–${s.to.slice(8)}.${s.to.slice(5, 7)})`]),
  ].map(([v, l]) => `<button class="btn ${state.originChoice === v ? 'on' : ''}" type="button" data-origin="${v}" aria-pressed="${state.originChoice === v}">${esc(l)}</button>`).join('');
  openSheet(`<h3>לאן מסתכלים?</h3><div class="opt-list two">${opts}</div>
    <div class="sec-title">מאיפה למדוד מרחקים?</div><div class="opt-list">${origins}</div>`, 'בחירת אזור');
}

// ---------- food dictionary ----------
const SPICE = ['🟢 לא חריף', '🌶️ קצת', '🌶️🌶️ חריף', '🌶️🌶️🌶️ חריף מאוד'];
function renderDict() {
  const dd = state.dishes;
  if (!dd) return;
  const tags = ['all', 'south', 'phuket', 'muslim', 'breakfast', 'baby', 'seafood', 'classic', 'sweet', 'drink'];
  $('#dictTags').innerHTML = tags.map((t) =>
    `<button class="chip ${state.dictTag === t ? 'on' : ''}" data-tag="${t}" type="button" aria-pressed="${state.dictTag === t}">${t === 'all' ? 'הכל' : t === 'baby' ? '👶 לנאם' : esc(dd.meta.tags[t])}</button>`).join('');
  $('#phraseList').innerHTML = dd.phrases.map((ph, i) =>
    `<li><button class="phrase" type="button" data-phrase="${i}"><span><span class="th" lang="th">${esc(ph.th)}</span><span class="say">${esc(ph.say)}</span></span><span>${esc(ph.he)}</span></button></li>`).join('');
  const q = state.dictQuery.trim().toLowerCase();
  const items = dd.dishes.filter((x) => (state.dictTag === 'all' || x.tags.includes(state.dictTag)) &&
    (!q || [x.he, x.say, x.th, x.desc].some((f) => f.toLowerCase().includes(q))));
  $('#dictList').innerHTML = items.length ? items.map((x) => `
    <li class="card dish">
      <button class="card-main" type="button" data-dish="${x.id}">
        <span class="body">
          <span class="name">${esc(x.he)}${x.tags.includes('baby') ? ' <span aria-label="מתאים לנאם">👶</span>' : ''} <span class="spice">${SPICE[x.spicy]}</span></span>
          <span class="th" lang="th">${esc(x.th)} <span class="say" lang="he">· ${esc(x.say)}</span></span>
          <span class="desc">${esc(x.desc)}</span>
        </span>
      </button></li>`).join('') : emptyHtml(`לא נמצאה מנה${q ? ` בשם "${esc(state.dictQuery)}"` : ''}`, 'ניקוי החיפוש', 'clear-dict');
}
// Big Thai text to show the waiter.
function showThai(th, say, he, desc) {
  openSheet(`
    <div class="show-th th" lang="th">${esc(th)}</div>
    <div class="show-say">${esc(say)}</div>
    <h2 style="text-align:center;margin-top:14px">${esc(he)}</h2>
    ${desc ? `<p class="sh-tip">${esc(desc)}</p>` : ''}
    ${desc ? '<div class="show-say">רוצים פחות חריף? להוסיף: <span class="th" lang="th">ไม่เผ็ด</span> (מאי פֶּט)</div>' : ''}`, he);
}

// ---------- rendering & events ----------
function renderCats() {
  const counts = {};
  for (const p of state.places) counts[p.category === 'cafe' ? 'food' : p.category] = (counts[p.category === 'cafe' ? 'food' : p.category] || 0) + 1;
  const chips = [['all', 'הכל'], ['fav', `❤️ שמורים${state.favs.size ? ` (${state.favs.size})` : ''}`],
    ...CAT_ORDER.filter((c) => counts[c]).map((c) => [c, `${CAT_ICON[c]} ${CAT_SHORT[c]}`])];
  $('#cats').innerHTML = chips.map(([c, l]) => `<button class="chip ${state.cat === c ? 'on' : ''}" data-cat="${c}" type="button" aria-pressed="${state.cat === c}">${l}</button>`).join('');
}
function renderHeader() {
  $('#regionLabel').textContent = AREAS[state.area].label;
  $('#babyBtn').setAttribute('aria-pressed', String(state.babyOnly));
}
function renderLists() {
  if (state.view === 'list') renderList();
  if (state.view === 'now') renderNow();
  if (state.view === 'dict') renderDict();
}
function renderAll() {
  renderHeader();
  renderCats();
  renderMap();
  updateMe();
  renderLists();
}
function setView(v) {
  state.view = v;
  document.querySelectorAll('.view').forEach((el) => el.classList.toggle('active', el.id === 'view-' + v));
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === v);
    if (b.dataset.view === v) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  document.body.classList.toggle('dict-mode', v === 'dict');
  if (v === 'map') setTimeout(() => map.invalidateSize(), 0);
  renderLists();
}
function toggleSet(set, key, id) {
  set.has(id) ? set.delete(id) : set.add(id);
  save(key, [...set]);
}

// Drag the sheet down to close it.
function bindSheetSwipe() {
  const card = $('.sheet-card');
  let y0 = null, dy = 0;
  card.addEventListener('touchstart', (e) => { if (card.scrollTop <= 0) { y0 = e.touches[0].clientY; dy = 0; card.style.transition = 'none'; } }, { passive: true });
  card.addEventListener('touchmove', (e) => {
    if (y0 === null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    card.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  card.addEventListener('touchend', () => {
    if (y0 === null) return;
    card.style.transition = '';
    if (dy > 90) closeSheet();
    card.style.transform = '';
    y0 = null;
  });
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
  $('#regionBtn').addEventListener('click', openAreaMenu);
  $('#searchBtn').addEventListener('click', () => { setView('list'); $('#placeSearch').focus(); });
  $('#placeSearch').addEventListener('input', (e) => { state.query = e.target.value; renderList(); });
  for (const id of ['#originLine', '#originLineNow']) $(id).addEventListener('click', openAreaMenu);
  $('#locateBtn').addEventListener('click', () => {
    if (state.origin) moveMap([state.origin.lat, state.origin.lon], state.origin.kind === 'gps' ? 14 : 13);
    else openAreaMenu();
  });
  // Cards: the main button opens details; 🧭 navigates; ❤️ saves.
  for (const list of ['#list', '#nowList', '#dictList']) {
    $(list).addEventListener('click', (e) => {
      const em = e.target.closest('[data-empty]');
      if (em) {
        if (em.dataset.empty === 'clear-dict') { state.dictQuery = ''; $('#dictSearch').value = ''; state.dictTag = 'all'; renderDict(); }
        else handleEmptyAction(em.dataset.empty);
        return;
      }
      const f = e.target.closest('[data-fav]');
      if (f) {
        toggleSet(state.favs, 'favs', f.dataset.fav); renderCats(); renderMap(); renderLists();
        $(`${list} [data-fav="${f.dataset.fav}"]`)?.focus({ preventScroll: true });
        return;
      }
      const b = e.target.closest('[data-id]'); if (b) openPlace(b.dataset.id);
    });
  }
  $('#dictSearch').addEventListener('input', (e) => { state.dictQuery = e.target.value; renderDict(); });
  $('#dictTags').addEventListener('click', (e) => { const b = e.target.closest('[data-tag]'); if (b) { state.dictTag = b.dataset.tag; renderDict(); } });
  $('#dictList').addEventListener('click', (e) => {
    const li = e.target.closest('[data-dish]'); if (!li) return;
    const x = state.dishes.dishes.find((y) => y.id === li.dataset.dish);
    showThai(x.th, x.say, x.he, x.desc);
  });
  $('#phraseList').addEventListener('click', (e) => {
    const li = e.target.closest('[data-phrase]'); if (!li) return;
    const ph = state.dishes.phrases[Number(li.dataset.phrase)];
    showThai(ph.th, ph.say, ph.he);
  });
  $('#shuffleBtn').addEventListener('click', () => { state.shuffleSeed = (state.shuffleSeed + 1) * 7919; renderNow(); });
  $('#sheet').addEventListener('click', (e) => {
    if (e.target.matches('.sheet') || e.target.closest('.close')) { closeSheet(); return; }
    const a = e.target.closest('[data-area]');
    if (a) { state.area = a.dataset.area; save('area', state.area); closeSheet(); flyToArea(state.area); renderAll(); return; }
    const o = e.target.closest('[data-origin]');
    if (o) { state.originChoice = o.dataset.origin; save('originChoice', state.originChoice); closeSheet(); resolveOrigin(); return; }
    const v = e.target.closest('[data-visit]');
    if (v) { toggleSet(state.visited, 'visited', v.dataset.visit); openPlace(v.dataset.visit); renderMap(); renderLists(); return; }
    const f = e.target.closest('[data-fav]');
    if (f) { toggleSet(state.favs, 'favs', f.dataset.fav); openPlace(f.dataset.fav); renderCats(); renderMap(); renderLists(); return; }
    const fly = e.target.closest('[data-fly]');
    if (fly) {
      const p = state.byId.get(fly.dataset.fly);
      closeSheet(); setView('map'); map.setView([p.lat, p.lon], 16);
    }
  });
  bindSheetSwipe();
  document.addEventListener('keydown', sheetKeys);
  const net = () => { $('#offline').hidden = navigator.onLine; };
  addEventListener('online', net); addEventListener('offline', net); net();
  // Re-evaluate "open now" and time-of-day every few minutes.
  setInterval(renderLists, 5 * 60 * 1000);
}

async function start() {
  const [res, dres] = await Promise.all([fetch('data/places.json'), fetch('data/dishes.json')]);
  state.data = await res.json();
  state.dishes = await dres.json();
  state.places = state.data.places;
  state.byId = new Map(state.places.map((p) => [p.id, p]));
  if (!AREAS[state.area]) state.area = 'all';
  initMap();
  bind();
  resolveOrigin();
  if (state.area === 'all') {
    const stay = stayForDate(thaiNow().date);
    if (stay) { const p = state.byId.get(stay.id); map.setView([p.lat, p.lon], 12); }
  }
  if ('serviceWorker' in navigator) {
    // When a new version takes over, reload once so the new app and data show up right away.
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) location.reload(); });
    navigator.serviceWorker.register('sw.js').then((reg) => reg.update()).catch(() => {});
  }
}
start();
