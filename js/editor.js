/* editor.js — UI del Quetzal Save Editor (SPA minimalista, fase pulido UX).
   Núcleo intacto: sav.js (checksum, secciones, party 104 B, PC bit-packed),
   data.js (tablas), learnsets.js (nivel + tutor NOVO MOV.) y names_es.js
   (nombres en español + rutas de sprites PokeAPI/pokesprite).

   Reglas del corpus (doc/06):
   - PC en SOLO LECTURA (formato ambiguo 38/31 B); no existe botón "Enviar a Caja".
   - Los PP no se editan ni se muestran como input: al asignar movimiento se
     escriben sus PP base (0x3C).
   - Al exportar: recomponer sección 1 (party + dinero XOR + medallas), recalcular
     checksum, verificar y descargar archivo NUEVO. El original nunca se toca.
   - Añadir Pokémon clona los metadatos de OT (bytes 0x10-0x27) de un miembro
     existente del equipo; requiere al menos uno. No se fabrican OTs desconocidos.

   Selectores: especie/movimiento/objeto usan una ventana modal de búsqueda
   (picker) con imágenes; género/naturaleza/habilidad/ball usan <select> nativo. */

'use strict';

/* ================= estado ================= */
const S = {
  save: null, fileName: '', party: [], dirty: false,
  editing: -1, deleting: -1,
  pcBuf: null, pcFmt: null, pcEditable: false, pcDirty: false,
  pcNames: [], pcCurrent: 0, pcEditing: null,
};
/* estado del modal de edición (sin tocar el save hasta Guardar) */
const M = { spId: 1, item: 0, moves: [0, 0, 0, 0], creating: false };

const $ = (id) => document.getElementById(id);
const SPRITE_BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/';
const PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="42" fill="#fff" stroke="#c9d2de" stroke-width="6"/><path d="M8 50a42 42 0 0 1 84 0z" fill="#e9edf3"/><line x1="8" y1="50" x2="92" y2="50" stroke="#c9d2de" stroke-width="6"/><circle cx="50" cy="50" r="13" fill="#fff" stroke="#c9d2de" stroke-width="6"/></svg>`);

/* ================= helpers de datos ================= */
const spName = (id) => (QZ.species[id - 1] ? QZ.species[id - 1][0] : `Especie ${id}`);
const mvName = (id) => (QZ.movesES && QZ.movesES[id - 1]) || (QZ.moves[id - 1] ? QZ.moves[id - 1][0] : `Mov. ${id}`);
const mvNameEn = (id) => (QZ.movesEN && QZ.movesEN[id - 1]) || (QZ.moves[id - 1] ? QZ.moves[id - 1][0] : '');
const itName = (id) => (id === 0 ? '(ninguno)' : (QZ.itemsES && QZ.itemsES[id - 1]) || QZ.items[id - 1] || `Objeto ${id}`);
const itNameEn = (id) => (id === 0 ? '(ninguno)' : (QZ.items[id - 1] || itName(id)));
const abName = (id) => (QZ.abilitiesES && QZ.abilitiesES[id]) || QZ.abilities[id] || `Habilidad ${id}`;
/* naturalezas: nombres oficiales en español (la tabla interna solo guarda el
   índice estándar de Gen 3; QZ.natures[n][1..2] = sube/baja stat, [0] = nombre EN) */
const NATURES_ES = ['Fuerte', 'Huraña', 'Audaz', 'Firme', 'Pícara', 'Osada', 'Dócil', 'Plácida',
  'Agitada', 'Floja', 'Miedosa', 'Activa', 'Seria', 'Alegre', 'Ingenua', 'Modesta', 'Afable',
  'Mansa', 'Tímida', 'Alocada', 'Serena', 'Amable', 'Grosera', 'Cauta', 'Rara'];
const natName = (n) => (QZ.natures[n] ? (NATURES_ES[n] || QZ.natures[n][0]) : `Nat ${n}`);
const ballName = (b) => (QZ.ballsES && QZ.ballsES[b]) || QZ.balls[b] || `Ball ${b}`;
const typeEs = { normal:'Normal', fighting:'Lucha', flying:'Volador', poison:'Veneno', ground:'Tierra', rock:'Roca', bug:'Bicho', ghost:'Fantasma', steel:'Acero', mystery:'???', fire:'Fuego', water:'Agua', grass:'Planta', electric:'Eléctrico', psychic:'Psíquico', ice:'Hielo', dragon:'Dragón', dark:'Siniestro', fairy:'Hada' };
const TYPE_COLOR = { normal:'#A8A878', fighting:'#C03028', flying:'#A890F0', poison:'#A040A0', ground:'#E0C068', rock:'#B8A038', bug:'#A8B820', ghost:'#705898', steel:'#B8B8D0', mystery:'#68A090', fire:'#F08030', water:'#6890F0', grass:'#78C850', electric:'#F8D030', psychic:'#F85888', ice:'#98D8D8', dragon:'#7038F8', dark:'#705848', fairy:'#EE99AC' };
const CAT_ES = { physical: 'Fís', special: 'Esp', status: 'Est' };
const STATN = ['HP', 'Ataque', 'Defensa', 'Velocidad', 'At. Esp.', 'Def. Esp.'];
const STAT_SHORT = ['HP', 'ATQ', 'DEF', 'VEL', 'ATQ ESP', 'DEF ESP'];
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const _normCache = new Map();
const normQ = (s) => {
  s = String(s);
  let v = _normCache.get(s);
  if (v === undefined) {
    v = s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (_normCache.size < 20000) _normCache.set(s, v);
  }
  return v;
};
/* búsqueda tolerante: cada palabra de la consulta debe aparecer en alguno de los
   campos (nombre ES, nombre EN o número); el orden no importa. La consulta se
   trocea una sola vez por pulsación y los nombres normalizados quedan en caché. */
let _qKey = null, _qToks = [];
function matchQ(q, ...fields) {
  if (q !== _qKey) { _qKey = q; _qToks = normQ(q).split(/\s+/).filter(Boolean); }
  const nf = fields.map(normQ);
  return _qToks.every(tok => nf.some(f => f.includes(tok)));
}
function matchDex(q, id) {
  if (!/^\d+$/.test(normQ(q).trim())) return false;
  const n = normQ(q).trim();
  return String(id) === n || String(id).padStart(4, '0').includes(n);
}
const mon = (i) => S.save.parsePartyRecord(S.party[i]);

/* ---------- sprites ----------
   Los sprites SIEMPRE usan el id de la forma en PokeAPI (QZ.species[][14]):
   el id interno de Quetzal NO coincide con el Dex nacional (p. ej. el interno
   1312 es Kingambit = Dex 983, y el interno 983 es Darmanitan de Galar,
   sprite de forma 10177). spriteId 0 = Forma Quetzal sin Dex → placeholder. */
function spriteUrl(speciesId, shiny) {
  const sp = QZ.species[speciesId - 1];
  const sid = sp ? sp[14] : 0; // [13]=dex nacional · [14]=id de sprite (forma)
  if (!sid) return null;
  return `${SPRITE_BASE}${shiny ? 'shiny/' : ''}${sid}.png`;
}
function spriteImg(speciesId, shiny, alt, cls) {
  const url = spriteUrl(speciesId, shiny);
  if (!url) return `<img class="${cls || ''}" src="${PLACEHOLDER}" alt="${escapeHtml(alt || '')}" title="Forma de Quetzal sin Dex nacional (sin sprite)">`;
  return `<img class="${cls || ''}" src="${url}" alt="${escapeHtml(alt || '')}" loading="lazy"
    onerror="this.onerror=null;this.src='${PLACEHOLDER}'">`;
}
/* icono de tipo para movimientos: un punto de color CSS, sin imágenes externas.
   Objetos: punto gris neutro (itemDot). */
function typeDot(type) {
  return `<span class="type-dot" style="background:${TYPE_COLOR[type] || '#888'}" title="${typeEs[type] || type}"></span>`;
}
function itemDot() {
  return `<span class="type-dot" style="background:#9aa4b2" title="Objeto"></span>`;
}
function typeChips(spEntry) {
  if (!spEntry) return '';
  return [...new Set([spEntry[1], spEntry[2]].filter(Boolean))]
    .map(t => `<span class="type-chip" style="background:${TYPE_COLOR[t] || '#888'}">${typeEs[t] || t}</span>`).join('');
}
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove('show'), ms);
}

/* ================= router SPA ================= */
const ROUTES = ['home', 'entrenador', 'equipo', 'pc'];
function navigateTo(route) {
  if (!ROUTES.includes(route)) route = 'home';
  if (routeFromHash() !== route) { location.hash = '#/' + route; return; } // el hashchange llama de nuevo
  ROUTES.forEach(r => {
    $(`page-${r}`).hidden = (r !== route);
    $(`page-${r}`).classList.toggle('active', r === route);
  });
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === route));
  closeDrawer();
  window.scrollTo(0, 0);
  // la animación de Pokémon cayendo es exclusiva de Inicio
  document.body.dataset.route = route;
  $('fall-bg').style.display = (route === 'home') ? '' : 'none';
  if (route === 'home') startFall();
}
function routeFromHash() {
  const r = (location.hash || '').replace(/^#\/?/, '');
  return ROUTES.includes(r) ? r : 'home';
}
window.addEventListener('hashchange', () => navigateTo(routeFromHash()));

/* ================= menú móvil ================= */
function openDrawer() { $('drawer').classList.add('open'); $('drawer-overlay').classList.add('open'); $('btn-burger').setAttribute('aria-expanded', 'true'); }
function closeDrawer() { $('drawer').classList.remove('open'); $('drawer-overlay').classList.remove('open'); $('btn-burger').setAttribute('aria-expanded', 'false'); }
$('btn-burger').addEventListener('click', openDrawer);
$('btn-close-drawer').addEventListener('click', closeDrawer);
$('drawer-overlay').addEventListener('click', closeDrawer);

/* ================= logo: sprite de la Poké Ball (objeto de PokeAPI) =================
   Si el sprite no carga, el logo usa la Great Ball pixelart local y el favicon conserva el de reserva. */
(function () {
  const logo = $('brand-ball');
  const fav = $('favicon');
  logo.addEventListener('load', () => { fav.href = logo.src; });
  logo.addEventListener('error', () => { logo.src = PX.url('greatball'); }, { once: true });
  if (logo.complete) {                                           // ya terminó antes de este script
    if (logo.naturalWidth) fav.href = logo.src; else logo.src = PX.url('greatball');
  }
})();

/* ================= tema (con transición día ↔ noche) =================
   · setTheme(t): aplica el tema de golpe (variables CSS, icono del botón, <meta theme-color>, localStorage).
   · toggleTheme(): usa la View Transitions API → el navegador captura TODA la página y el tema nuevo
     se revela con un círculo que crece desde el botón (Lunatone → noche, Solrock → día), con un aro
     de luz en el borde y el icono girando. Al ser toda la página, ningún objeto cambia a destiempo.
   · Sin soporte de View Transitions → respaldo: fundido de colores de todos los elementos
     (clase .theme-fading). Con «reducir movimiento» el cambio es instantáneo. */
const THEME_BAR = { light: '#fffdf5', dark: '#121211' };
const THEME_MS = 850;
const THEME_EASE = 'cubic-bezier(.65, 0, .35, 1)';
let themeBusy = false;

function setTheme(t) {
  document.documentElement.dataset.theme = t;
  // el botón muestra el Pokémon del tema al que se cambia: Lunatone → noche, Solrock → día
  $('theme-img').src = PX.url(t === 'dark' ? PX.SUN : PX.MOON);
  $('btn-theme').title = t === 'dark' ? 'Cambiar a tema claro (Solrock)' : 'Cambiar a tema oscuro (Lunatone)';
  const bar = document.querySelector('meta[name="theme-color"]');
  if (bar) bar.content = THEME_BAR[t];
  localStorage.setItem('qz-theme', t);
}
// precarga ambos iconos para que el cambio no parpadee
[PX.SUN, PX.MOON].forEach(n => { new Image().src = PX.url(n); });
setTheme(localStorage.getItem('qz-theme') || 'light');

function themeIconSpin() {                      // el astro sale girando y el nuevo asoma desde abajo
  const img = $('theme-img');
  if (!img.animate) return;
  img.animate([
    { transform: 'translateY(16px) rotate(-140deg) scale(.35)', opacity: 0 },
    { transform: 'translateY(0) rotate(0) scale(1)', opacity: 1 }
  ], { duration: THEME_MS * .8, easing: 'cubic-bezier(.2, .9, .25, 1.15)', fill: 'backwards' });
}

function toggleTheme() {
  if (themeBusy) return;
  const root = document.documentElement;
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) { setTheme(next); return; }

  themeBusy = true;
  const btn = $('btn-theme').getBoundingClientRect();
  const x = btn.left + btn.width / 2, y = btn.top + btn.height / 2;
  const R = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));   // hasta la esquina más lejana

  // respaldo: sin View Transitions → fundido general de colores
  if (!document.startViewTransition) {
    root.classList.add('theme-fading');
    setTheme(next);
    themeIconSpin();
    setTimeout(() => { root.classList.remove('theme-fading'); themeBusy = false; }, 650);
    return;
  }

  root.classList.add('theme-switching');         // congela la caída de Pokémon durante el cambio
  let ring;
  const vt = document.startViewTransition(() => {
    setTheme(next);
    ring = document.createElement('div');        // aro de luz: solo existe en el tema nuevo
    ring.className = 'theme-ring';
    ring.style.cssText = `--cx:${x}px;--cy:${y}px;--r:0px`;
    document.body.appendChild(ring);
  });                                            // (sin esperas: los iconos ya están precargados)
  vt.ready.then(() => {
    const opts = { duration: THEME_MS, easing: THEME_EASE, fill: 'both' };
    root.animate(                                // el tema nuevo se revela en círculo desde el botón
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${R}px at ${x}px ${y}px)`] },
      { ...opts, pseudoElement: '::view-transition-new(root)' });
    if (ring) ring.animate({ '--r': ['0px', `${R}px`] }, opts);   // el aro viaja con el borde
    themeIconSpin();
  }).catch(() => {});
  vt.finished.finally(() => {
    if (ring) ring.remove();
    root.classList.remove('theme-switching');
    themeBusy = false;
  });
}
$('btn-theme').addEventListener('click', toggleTheme);

/* ================= fondo animado (Home): Pokémon cayendo =================
   Ilustraciones oficiales de PokeAPI. Cada Pokémon baja en línea recta y su imagen se
   balancea (ver .fall-item en styles.css). Tres profundidades: lejos = pequeño, lento y
   difuminado; cerca = grande y nítido. Solo se anima transform/opacity (fluido).
   En pantallas anchas se reparten por los laterales para no tapar el texto. */
const ART_BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/';
const FALL_IDS = [25, 6, 9, 3, 94, 133, 448, 658, 445, 778, 384, 254, 257, 260, 282, 373, 376, 380,
                  359, 350, 197, 196, 700, 571, 249, 150, 130, 149, 248, 306];
const FALL_DEPTH = [                       // lejos · medio · cerca
  { size: 70,  op: .38, dur: 34, blur: 2.0, amp: 10, rot: 4 },
  { size: 100, op: .62, dur: 26, blur: 0.6, amp: 16, rot: 6 },
  { size: 136, op: .90, dur: 20, blur: 0,   amp: 22, rot: 8 }
];
let fallBucket = '';
const shuffled = (arr) => arr.map(v => [Math.random(), v]).sort((p, q) => p[0] - q[0]).map(p => p[1]);
function fallBucketNow() { const w = window.innerWidth; return w >= 1000 ? 'wide' : w >= 720 ? 'mid' : 'narrow'; }

function startFall() {
  const bucket = fallBucketNow();
  if (bucket === fallBucket) return;       // ya construido para este ancho
  fallBucket = bucket;
  const bg = $('fall-bg');
  bg.textContent = '';
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const count = bucket === 'wide' ? 12 : bucket === 'mid' ? 9 : 7;
  const W = window.innerWidth;
  const side = (W - 700) / 2;                       // ancho libre a cada lado del contenido (hero = 700 px)
  const scale = bucket === 'narrow' ? .7 : bucket === 'wide' ? Math.min(1, side * .8 / 136) : 1;
  // carriles horizontales (%): laterales en pantallas anchas, todo el ancho en las demás
  const lanes = [];
  if (bucket === 'wide') {
    const half = count / 2;
    for (let i = 0; i < half; i++) {
      const off = side * (.14 + (i + .5) * (.72 / half));      // centro del carril, en px desde el borde
      lanes.push(off / W * 100);
      lanes.push(100 - off / W * 100);
    }
  } else {
    for (let i = 0; i < count; i++) lanes.push(6 + (i + .5) * (88 / count));
  }
  const xs = shuffled(lanes);
  const ids = shuffled(FALL_IDS).slice(0, count);
  const depths = shuffled(Array.from({ length: count }, (_, i) => i % 3));
  ids.forEach((id, i) => {
    const D = FALL_DEPTH[depths[i]];
    const size = Math.round(D.size * scale * (.9 + Math.random() * .2));
    const dur = D.dur * (.9 + Math.random() * .25);
    const el = document.createElement('div');
    el.className = 'fall-item';
    const set = (k, v) => el.style.setProperty(k, v);
    set('--x', (xs[i] + (bucket === 'wide' ? 0 : (Math.random() - .5) * 2)).toFixed(1) + '%');
    set('--s', size + 'px');
    set('--o', (bucket === 'narrow' ? D.op * .75 : D.op).toFixed(2));
    set('--t', dur.toFixed(1) + 's');
    set('--d', (-dur * ((i + Math.random() * .7) / count)).toFixed(1) + 's');   // ya repartidos al cargar
    set('--a', D.amp + 'px');
    set('--r', D.rot + 'deg');
    set('--sw', (4.5 + Math.random() * 3).toFixed(1) + 's');
    set('--sd', (-Math.random() * 6).toFixed(1) + 's');
    set('--bl', D.blur + 'px');
    if (still) el.style.top = (8 + Math.random() * 78).toFixed(0) + 'vh';
    const img = new Image();
    img.alt = '';
    img.decoding = 'async';
    img.onload = () => bg.appendChild(el);          // solo aparece cuando la imagen ya cargó
    img.onerror = () => { img.onerror = null; img.src = `${SPRITE_BASE}${id}.png`; };  // respaldo: sprite pequeño
    img.src = `${ART_BASE}${id}.png`;
    el.appendChild(img);
  });
}
let fallResizeT;
window.addEventListener('resize', () => {
  clearTimeout(fallResizeT);
  fallResizeT = setTimeout(() => { if (document.body.dataset.route === 'home') startFall(); }, 300);
});

/* ================= carga del archivo ================= */
const dz = $('drop-zone');
$('btn-browse').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (e) => { if (e.target.files.length) loadFile(e.target.files[0]); });
['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
dz.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files[0];
  if (f) loadFile(f);
});

function loadFile(file) {
  const fr = new FileReader();
  fr.onload = () => {
    try {
      onLoad(new Uint8Array(fr.result), file.name);
    } catch (err) {
      homeStatus(`<span class="status-bad">¡Error! ${escapeHtml(err.message || String(err))}</span>`);
      $('nav-status').className = 'save-dot err';
    }
  };
  fr.readAsArrayBuffer(file);
}

function homeStatus(html) { $('home-status').innerHTML = html; }

function onLoad(bytes, name) {
  S.save = new QuetzalSave(bytes);
  S.fileName = name;
  S.dirty = false;
  S.pcBuf = null; S.pcDirty = false; S.pcFmt = null; S.pcEditable = false; S.pcEditing = null;

  // construir S.party una sola vez; renderParty NUNCA recarga del save
  // (los registros editados viven en S.party hasta exportar)
  const n = Math.min(S.save.partyCount(), 6);
  S.party = [];
  for (let i = 0; i < n; i++) S.party.push(S.save.partyRecord(i));

  const checks = S.save.verifyChecksums();
  const bad = checks.filter(c => !c.ok).map(c => c.sid);
  $('nav-status').className = 'save-dot' + (bad.length ? ' err' : ' on');
  $('nav-status').title = bad.length
    ? `Checksums inválidos en secciones: ${bad.join(', ')}`
    : `Save cargado · 16/16 checksums OK`;

  homeStatus(`
    <div class="status-line"><span class="status-ok">OK ${escapeHtml(name)}</span>
      <span class="text-muted">· ${(bytes.length / 1024).toFixed(0)} KiB${bytes.length > 0x20000 ? ` (${bytes.length - 0x20000} B residuales ignorados)` : ''}</span></div>
    ${bad.length
      ? `<div class="status-line"><span class="status-bad">¡Aviso! Checksums inválidos en secciones ${bad.join(', ')} — el juego puede ignorar este save; exporta bajo tu propio riesgo.</span></div>`
      : `<div class="status-line"><span class="status-ok">16/16 checksums verificados</span></div>`}`);

  $('home-shortcuts').classList.remove('d-none');
  $('btn-export').disabled = false;
  $('btn-add').disabled = false;
  $('btn-txt').disabled = false;
  renderTrainer();
  renderPc();      // antes que renderParty: detecta si el PC es editable (activa el botón «→ PC» de las tarjetas)
  renderParty();
  toast('Partida cargada correctamente');
  navigateTo('entrenador');
}

/* ================= entrenador ================= */
function renderTrainer() {
  const t = S.save.trainer();
  S.money = S.save.money();
  S.badges = S.save.badges();
  $('trainer-card').innerHTML = `
    <div class="trainer-grid">
      <div class="t-data"><div class="lab">Nombre</div><div class="val">${escapeHtml(t.name)}</div></div>
      <div class="t-data"><div class="lab">TID / SID</div><div class="val">${t.tid} / ${t.sid}</div></div>
      <div class="t-data"><div class="lab">Dinero</div>
        <div class="money-edit"><span class="money-symbol">₽</span>
          <input class="input" id="in-money" type="number" min="0" max="999999" value="${S.money}"></div></div>
      <div class="t-data"><div class="lab">Tiempo de juego</div><div class="val">${t.hours}h ${t.minutes}m ${t.seconds}s</div></div>
      <div class="t-data"><div class="lab">Slot activo</div><div class="val">${S.save.activeSlot === 0 ? 'A' : 'B'} (índice ${S.save.slotIndex})</div></div>
      <div class="t-data"><div class="lab">Clave dinero</div><div class="val">0x${t.moneyKey.toString(16).toUpperCase().padStart(8, '0')}</div></div>
      <div class="t-data" style="grid-column: 1 / -1;"><div class="lab">Medallas de Hoenn (clic para alternar)</div>
        <div class="medals">${S.badges.map((b, i) =>
          `<span class="medal${b ? ' on' : ''}" data-i="${i}" title="Medalla ${i + 1}">${i + 1}</span>`).join('')}</div></div>
    </div>
    <div class="t-actions">
      <span class="status-line" style="margin:0;">Party en el save: <strong>${S.save.partyCount()}</strong> · Equipo actual: <strong>${S.party.length}</strong>${S.dirty ? ' · <em>cambios sin exportar</em>' : ''}</span>
    </div>`;

  $('in-money').addEventListener('input', (e) => { S.money = Math.max(0, Math.min(999999, Number(e.target.value) || 0)); S.dirty = true; });
  document.querySelectorAll('.medal').forEach(el => el.addEventListener('click', () => {
    const i = Number(el.dataset.i);
    S.badges[i] = S.badges[i] ? 0 : 1;
    el.classList.toggle('on', !!S.badges[i]);
    S.dirty = true;
  }));
}

/* ================= equipo ================= */
function renderParty() {
  $('party-count').textContent = `${S.party.length}/6`;

  if (!S.party.length) {
    $('party-grid').innerHTML = `
      <div class="card empty-team">
        <p class="empty-note">El equipo está vacío (0/6).</p>
        <div class="empty-actions">
          <button class="btn btn-primary" id="btn-add-empty">Crear Pokémon</button>
          <button class="btn btn-outline" id="btn-txt-empty">Pegar equipo en texto</button>
        </div>
        <p class="hint">Sin ningún miembro en el equipo, el OT se reconstruye a partir de los datos
        del entrenador (nombre y TID/SID del save). Puedes añadir uno o varios hasta completar los 6 huecos.</p>
      </div>`;
    $('btn-add-empty').addEventListener('click', () => openModal(-1));
    $('btn-txt-empty').addEventListener('click', openTxtBox);
    return;
  }

  const cards = S.party.map((raw, i) => partyCardHtml(i)).join('');
  const addCard = S.party.length < 6
    ? `<button class="p-card add-card" id="btn-add-slot" title="Añadir Pokémon"><span class="plus">+</span><span>Añadir Pokémon</span></button>`
    : '';
  $('party-grid').innerHTML = cards + addCard;

  document.querySelectorAll('.p-card[data-i]').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.grip') || e.target.closest('[data-dep]') || PartyDrag.suppress) return;
      openModal(Number(el.dataset.i));
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target === el && !PartyDrag.suppress) openModal(Number(el.dataset.i));
    });
  });
  document.querySelectorAll('[data-dep]').forEach(btn =>
    btn.addEventListener('click', (e) => { e.stopPropagation(); depositToBox(Number(btn.dataset.dep)); }));
  attachPartyDrag();
  const addBtn = $('btn-add-slot');
  if (addBtn) addBtn.addEventListener('click', () => openModal(-1));
}

function partyCardHtml(i) {
  const m = mon(i);
  if (!m.species) {
    return `<button class="p-card add-card" data-i="${i}"><span class="plus">+</span><span>Slot vacío — toca para añadir</span></button>`;
  }
  const sp = QZ.species[m.species - 1];
  const dep = S.pcEditable
    ? `<button class="card-act" type="button" data-dep="${i}" title="Enviar a la caja del PC">→ PC</button>`
    : '';
  return `
  <div class="p-card" data-i="${i}" role="button" tabindex="0">
    <span class="grip" data-grip title="Arrastra para cambiar el orden del equipo" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="15" height="15"><path d="M9 4h2.4v2.4H9zM12.6 4H15v2.4h-2.4zM9 10.8h2.4v2.4H9zM12.6 10.8H15v2.4h-2.4zM9 17.6h2.4V20H9zM12.6 17.6H15V20h-2.4z" fill="currentColor"/></svg>
    </span>
    <div class="sprite-wrap">${spriteImg(m.species, m.shiny, spName(m.species))}</div>
    <div class="meta">
      <div class="p-name">${m.shiny ? '<span class="shiny-mark">✦</span>' : ''}
        <span class="nm">${escapeHtml(m.nickname || spName(m.species))}</span>
        <span class="lvl">Nv. ${m.level}</span></div>
      <div class="type-row">${typeChips(sp)}</div>
      <div class="p-item-line">${m.item ? `<span class="item-name">${escapeHtml(itName(m.item))}</span>` : 'sin objeto'} · OT ${escapeHtml(m.ot)}</div>
    </div>
    ${dep}
  </div>`;
}

/* ================= enviar del equipo a una caja del PC =================
   Codifica el registro de 104 B a formato PC (38/31/21 B) con qzEncodePcRecord
   y lo coloca en el primer hueco libre: caja actual del juego → resto de cajas.
   El PC no guarda OT, PID completo ni amistad (formato del juego). */
function depositToBox(i) {
  if (!S.save || !S.pcEditable) { toastPcRo(); return; }
  const raw = S.party[i];
  if (!raw) return;
  const m = S.save.parsePartyRecord(raw);
  if (!m.species) { toast('Ese hueco está vacío'); return; }
  const sp = QZ.species[m.species - 1];
  const boxes = S.pcFmt.boxes;
  const start = S.pcCurrent || 0;
  let target = -1;
  for (let k = 0; k < boxes && target < 0; k++) {
    const box = (start + k) % boxes;
    for (let p = 0; p < QZS.BOX_SLOTS; p++) {
      if (!pcRecordAt(box * 30 + p)) { target = box * 30 + p; break; }
    }
  }
  if (target < 0) { toast('El PC está lleno: no hay huecos libres en ninguna caja', 4200); return; }
  const evs = m.evs.map(v => Math.min(252, Math.round(v / 4) * 4)); // el PC guarda EVs en múltiplos de 4
  const gb = sp ? sp[12] : 255;
  const female = qzIsFemale(m.pid & 0xFF, gb) === true;
  const rec = qzEncodePcRecord({
    species: m.species, item: m.item, exp: m.exp, ball: m.ball,
    shiny: m.shiny, moves: m.moves, evs, ivs: m.ivs, female,
    nature: m.nature, abilityNum: m.abilityNum, flags: 0,
    hpCur: m.hpCur || m.stats[0], pp: m.pp, nickname: m.nickname,
  }, pcSize());
  S.pcBuf.set(rec, pcRecOff(target));
  S.pcDirty = true; S.dirty = true;
  S.party.splice(i, 1);
  renderParty();
  updatePcMeta();
  if (document.body.dataset.route === 'pc') renderPcBox();
  const dstBox = Math.floor(target / 30), dstPos = target % 30;
  toast(`${spName(m.species)} enviado a ${S.pcNames[dstBox] || ('Caja ' + (dstBox + 1))} · hueco ${dstPos + 1} (se escribe al exportar)`, 4000);
}

/* ================= reordenar el equipo arrastrando =================
   Cada tarjeta tiene un asa ⠿ (esquina superior derecha). Al arrastrar, la tarjeta
   sigue al puntero y las demás se apartan con animación FLIP; al soltar se reordena
   S.party — el orden físico de la sección 1 del .sav, es decir, el orden real de
   combate que el juego usa. Funciona con ratón y con táctil (pointer events).
   El botón «→ PC» y el click de edición no se disparan durante el arrastre. */
const PartyDrag = { suppress: false };
function attachPartyDrag() {
  document.querySelectorAll('.p-card[data-i] [data-grip]').forEach(grip => {
    grip.addEventListener('pointerdown', (e) => startPartyDrag(e, grip), { passive: false });
  });
}
function startPartyDrag(e, grip) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const card = grip.closest('.p-card[data-i]');
  const grid = $('party-grid');
  if (!card || !S.save) return;
  e.preventDefault();
  e.stopPropagation();
  try { grip.setPointerCapture(e.pointerId); } catch (_) {}
  const r0 = card.getBoundingClientRect();
  const offX = e.clientX - r0.left, offY = e.clientY - r0.top;
  let moved = false;
  card.classList.add('dragging');
  grid.classList.add('drag-active');

  const others = () => [...grid.querySelectorAll('.p-card[data-i]')].filter(c => c !== card);
  function flipMove(mutate) { // anima a los demás al apartarse
    const sibs = others();
    const first = new Map(sibs.map(el => [el, el.getBoundingClientRect()]));
    mutate();
    sibs.forEach(el => {
      const a = first.get(el), b = el.getBoundingClientRect();
      const dx = a.left - b.left, dy = a.top - b.top;
      if (!dx && !dy) return;
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => {
        el.style.transition = 'transform .18s ease';
        el.style.transform = '';
        setTimeout(() => { el.style.transition = ''; }, 200);
      });
    });
  }
  const onMove = (ev) => {
    moved = true;
    card.style.transform = `translate(${ev.clientX - offX - r0.left}px, ${ev.clientY - offY - r0.top}px)`;
    const rest = others();
    let before = null;
    for (const c of rest) {
      const r = c.getBoundingClientRect();
      if (ev.clientY < r.top + r.height / 2) { before = c; break; }
    }
    const isBefore = before && before.previousElementSibling === card;
    const atEnd = !before;
    const addCard = $('btn-add-slot');
    if (isBefore || (atEnd && (!addCard || addCard.previousElementSibling === card))) return;
    flipMove(() => {
      if (before) grid.insertBefore(card, before);
      else if (addCard) grid.insertBefore(card, addCard);
      else grid.appendChild(card);
    });
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointercancel', onUp);
    window.removeEventListener('pointerup', onUp);
    card.classList.remove('dragging');
    card.style.transform = '';
    grid.classList.remove('drag-active');
    if (!moved || !S.save) return;
    PartyDrag.suppress = true;          // evita abrir el editor con el click de soltar
    setTimeout(() => { PartyDrag.suppress = false; }, 150);
    const order = [...grid.querySelectorAll('.p-card[data-i]')].map(el => Number(el.dataset.i));
    if (order.some((v, k) => v !== k)) {
      S.party = order.map(i => S.party[i]);
      S.dirty = true;
      renderParty();
      toast('Orden del equipo actualizado (se guarda al exportar)');
    }
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

/* ================= PC (editable si el formato no es ambiguo) ================= */
function pcInit() { // detección de formato + buffer editable (una vez por archivo)
  const info = S.save.pcContents();
  S.pcFmt = info.format;
  S.pcEditable = !!info.format && !info.ambiguous;
  S.pcBuf = S.save.pcBuffer();
  S.pcNames = info.boxNames;
  S.pcCurrent = info.currentBox;
}
const pcSize = () => (S.pcFmt ? S.pcFmt.size : 38);
const pcRecOff = (s) => QZS.PC_RECORDS_OFFSET + s * pcSize(); // s = caja*30 + posición
function pcRecordAt(s) { // null si el slot está vacío (todo a cero)
  const off = pcRecOff(s);
  const rec = S.pcBuf.subarray(off, off + pcSize());
  for (let b = 0; b < rec.length; b++) if (rec[b]) return S.save.parsePcRecord(S.pcBuf, off, pcSize(), Math.floor(s / 30), s % 30);
  return null;
}
function pcCount() {
  let n = 0;
  for (let s = 0; s < S.pcFmt.boxes * 30; s++) if (pcRecordAt(s)) n++;
  return n;
}

function renderPc() {
  if (!S.pcBuf) pcInit();
  const badge = $('pc-badge');
  if (S.pcEditable) {
    badge.textContent = `Editable · ${pcSize()}B × ${S.pcFmt.boxes} cajas`;
    badge.title = 'Toca un Pokémon para editarlo, un hueco vacío para crear, y «Liberar» para borrar. Los cambios se escriben al exportar.';
  } else {
    badge.textContent = 'Solo lectura · formato ambiguo';
    badge.title = `Candidatos: ${(S.save.detectPcFormat().candidates || []).map(c => `${c.size}B×${c.boxes}`).join(' · ')} (doc/02 §7)`;
  }
  const sel = $('pc-box-sel');
  sel.innerHTML = S.pcNames.map((n, i) => `<option value="${i}">${escapeHtml(n)}</option>`).join('');
  sel.onchange = renderPcBox;
  updatePcMeta();
  renderPcBox();
}

function updatePcMeta() {
  $('pc-meta').textContent = `${pcCount()} Pokémon en el PC · caja actual del juego: ${S.pcNames[S.pcCurrent] ?? S.pcCurrent}` +
    (S.pcDirty ? ' · cambios sin exportar' : '');
}

function renderPcBox() {
  const box = Number($('pc-box-sel').value || 0);
  let html = '';
  const byPos = {};
  for (let p = 0; p < 30; p++) {
    const m = pcRecordAt(box * 30 + p);
    if (m) byPos[p] = m;
  }
  for (let p = 0; p < 30; p++) {
    const m = byPos[p];
    if (!m) {
      html += S.pcEditable
        ? `<button class="pc-slot add" data-p="${p}" title="Crear Pokémon en este hueco"><span class="plus">+</span></button>`
        : `<div class="pc-slot" title="Vacío"></div>`;
      continue;
    }
    html += `<button class="pc-slot filled" data-p="${p}" title="${escapeHtml(m.nickname || spName(m.species))} · ≈Nv.${qzLevelForExp(m.exp)} · ${natName(m.nature)}${S.pcEditable ? '' : ' · solo lectura'}">
      ${m.shiny ? '<span class="shiny-dot">✦</span>' : ''}${spriteImg(m.species, m.shiny, spName(m.species))}</button>`;
  }
  $('pc-grid').innerHTML = html;
  document.querySelectorAll('.pc-slot[data-p]').forEach(el => el.addEventListener('click', () => {
    if (!S.pcEditable) { toastPcRo(); return; }
    openPcEditor(Number($('pc-box-sel').value || 0), Number(el.dataset.p));
  }));
}
function toastPcRo() {
  toast('El PC está en solo lectura: el formato de registro es ambiguo en este save (38 vs 31 B) y escribir con el supuesto equivocado lo corrompería.', 4200);
}

/* ---------- modal del PC ---------- */
const P = { box: 0, pos: 0, creating: false, spId: 1, item: 0, moves: [0, 0, 0, 0], flags: 0 };

function openPcEditor(box, p) {
  const s = box * 30 + p;
  const m = pcRecordAt(s);
  P.box = box; P.pos = p; P.creating = !m;
  P.spId = m ? m.species : 1;
  P.item = m ? m.item : 0;
  P.moves = m ? m.moves.slice() : defaultMoves(P.spId, 50);
  P.flags = m ? m.flags : 0; // bits no documentados del registro original (se conservan)
  $('pcm-title').textContent = P.creating ? `Crear en ${S.pcNames[box]} · hueco ${p + 1}` : (m.nickname || spName(m.species));
  $('pcm-sprite').src = spriteUrl(P.spId, m && m.shiny) || PLACEHOLDER;
  $('pcm-types').innerHTML = typeChips(QZ.species[P.spId - 1]);
  updatePcSpeciesBtn();
  updatePcItemBtn();
  $('pf-nickname').value = m ? m.nickname : '';
  $('pf-level').value = m ? Math.max(1, qzLevelForExp(m.exp)) : 50;
  fillSelect($('pf-nature'), QZ.natures.map((n, k) => ({ v: k, t: `${k} ${natName(k)}` })), m ? m.nature : 0);
  fillPcAbility(P.spId, m ? m.abilityNum : 0);
  fillSelect($('pf-ball'), QZ.balls.map((n, k) => ({ v: k, t: ballName(k) })), m ? Math.min(m.ball, 25) : 4);
  $('pf-shiny').checked = m ? m.shiny : false;
  $('pf-female').checked = m ? m.female : false;
  const showNick = pcSize() === 38 || pcSize() === 31;
  $('pf-nickname').disabled = !showNick;
  $('pf-pp-note').hidden = pcSize() !== 38;
  $('pcm-delete').disabled = P.creating;
  $('pcm-delete').classList.remove('armed');
  $('pcm-delete').textContent = 'Liberar hueco';
  $('pcm-withdraw').hidden = P.creating || S.party.length >= 6;
  $('pcm-withdraw').title = S.party.length >= 6 ? 'El equipo está lleno (6/6)' : 'Copia este Pokémon al equipo y libera el hueco del PC';
  const tbody = $('pf-stats').tBodies[0];
  tbody.querySelector('.row-base').innerHTML = `<td>Base</td>` + pcBaseHtml(P.spId);
  tbody.querySelector('.row-iv').innerHTML = `<td>IVs <small>(0-31)</small></td>` + [0, 1, 2, 3, 4, 5].map(k =>
    `<td><input type="number" min="0" max="31" data-f="piv" data-k="${k}" value="${m ? m.ivs[k] : 0}"></td>`).join('');
  tbody.querySelector('.row-ev').innerHTML = `<td>EVs <small>(0-252)</small></td>` + [0, 1, 2, 3, 4, 5].map(k =>
    `<td><input type="number" min="0" max="252" step="4" data-f="pev" data-k="${k}" value="${m ? m.evs[k] : 0}"></td>`).join('');
  renderPcMoveBtns();
  recalcPcModal();
  $('pcmodal').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closePcModal() {
  $('pcmodal').classList.remove('open');
  if (!$('modal').classList.contains('open') && !$('pick').classList.contains('open') && !$('txtbox').classList.contains('open')) document.body.style.overflow = '';
  S.pcEditing = null;
}
function pcBaseHtml(spId) {
  const sp = QZ.species[spId - 1];
  return sp ? [sp[3], sp[4], sp[5], sp[6], sp[7], sp[8]].map(v => `<td>${v}</td>`).join('') : '<td colspan="6">—</td>';
}
function updatePcSpeciesBtn() {
  $('pf-species-btn').title = spName(P.spId);
  $('pf-species-btn').innerHTML = `<span class="pick-btn-img">${spriteImg(P.spId, false, spName(P.spId))}</span>
    <span class="pick-btn-txt"><b>ID interno ${P.spId}</b></span>`;
}
function updatePcItemBtn() {
  $('pf-item-btn').innerHTML = `<span class="pick-btn-img sm">${itemDot()}</span>
    <span class="pick-btn-txt"><b>${escapeHtml(P.item ? itName(P.item) : '(ninguno)')}</b>
    <small>${P.item ? '#' + P.item : 'toca para elegir'}</small></span>`;
}
function renderPcMoveBtns() {
  $('pf-moves').innerHTML = [0, 1, 2, 3].map(k =>
    `<button class="pick-btn mv-btn" type="button" data-pslot="${k}">${moveBtnHtml(P.moves[k])}</button>`).join('');
  document.querySelectorAll('.mv-btn[data-pslot]').forEach(btn =>
    btn.addEventListener('click', () => openPcMovePicker(Number(btn.dataset.pslot))));
}
function fillPcAbility(spId, num) {
  const sp = QZ.species[spId - 1];
  const abil = sp ? [[sp[9], 0], [sp[10], 1], [sp[11], 2]] : [];
  fillSelect($('pf-ability'), abil.filter(a => a[0]).map(a =>
    ({ v: a[1], t: (a[1] === 2 ? 'OCULTA: ' : '') + abName(a[0]) })), num);
}
function setPcSpecies(spId) {
  P.spId = spId;
  $('pcm-sprite').src = spriteUrl(spId, $('pf-shiny').checked) || PLACEHOLDER;
  $('pcm-types').innerHTML = typeChips(QZ.species[spId - 1]);
  updatePcSpeciesBtn();
  fillPcAbility(spId, 0);
  if (P.creating) { P.moves = defaultMoves(spId, Number($('pf-level').value) || 50); renderPcMoveBtns(); }
  recalcPcModal();
}
function pcModalState() {
  const sp = QZ.species[P.spId - 1];
  const ivs = [...document.querySelectorAll('#pf-stats [data-f="piv"]')].map(el => Math.max(0, Math.min(31, Number(el.value) || 0)));
  const evs = [...document.querySelectorAll('#pf-stats [data-f="pev"]')].map(el => Math.max(0, Math.min(252, Number(el.value) || 0)));
  const level = Math.max(1, Math.min(100, Number($('pf-level').value) || 1));
  const nature = Number($('pf-nature').value) || 0;
  const base = sp ? [sp[3], sp[4], sp[5], sp[6], sp[7], sp[8]] : [0, 0, 0, 0, 0, 0];
  return { sp, ivs, evs, level, nature, base, stats: qzCalcStats(base, level, ivs, evs, nature) };
}
function pcEvInvalid() {
  const bad = [];
  let sum = 0;
  document.querySelectorAll('#pf-stats [data-f="piv"]').forEach(el => {
    const v = Number(el.value);
    const badNow = !Number.isFinite(v) || v < 0 || v > 31 || el.value === '';
    el.classList.toggle('invalid', badNow);
    if (badNow) bad.push(`IV ${STATN[Number(el.dataset.k)]}`);
  });
  document.querySelectorAll('#pf-stats [data-f="pev"]').forEach(el => {
    const v = Number(el.value);
    const badNow = !Number.isFinite(v) || v < 0 || v > 252 || el.value === '';
    el.classList.toggle('invalid', badNow);
    if (badNow) bad.push(`EV ${STATN[Number(el.dataset.k)]}`);
    if (Number.isFinite(v) && v > 0) sum += v;
  });
  $('pf-ev-total').textContent = `Σ EVs: ${sum}/510`;
  $('pf-ev-total').classList.toggle('bad', sum > 510);
  if (sum > 510) bad.push(`suma de EVs ${sum} > 510`);
  return bad.length ? bad : null;
}
function recalcPcModal() {
  const st = pcModalState();
  $('pf-stats').querySelector('.row-base').innerHTML = `<td>Base</td>` + pcBaseHtml(P.spId);
  $('pf-stats').querySelector('.row-calc').innerHTML = `<td>Calculados</td>` + st.stats.map(v => `<td class="calc">${v}</td>`).join('');
  renderRadarInto($('radar-pc'), st.stats);
  renderExpPc(st.level);
  pcEvInvalid();
}
function renderExpPc(level) {
  const pct = Math.max(0, Math.min(100, Math.round((level / 100) * 100)));
  $('pf-exp-fill').style.width = pct + '%';
  $('pf-exp-label').textContent = `Nv. ${level} · ${qzExpForLevel(level).toLocaleString('es')} EXP`;
}

/* guardar registro PC: codifica 38/31/21 B en S.pcBuf (se escribe al exportar) */
$('pcm-save').addEventListener('click', () => {
  const bad = pcEvInvalid();
  if (bad) { toast('Valores fuera de rango: ' + bad.slice(0, 3).join(', ') + (bad.length > 3 ? '…' : ''), 3600); return; }
  const st = pcModalState();
  const moves = P.moves.slice();
  const size = pcSize();
  const exp = qzExpForLevel(st.level);
  const hpMax = st.stats[0];
  const pp = size === 38 ? moves.map(mv => (mv ? QZ.moves[mv - 1][5] : 0)) : null;
  const rec = qzEncodePcRecord({
    species: P.spId, item: P.item, exp, ball: Number($('pf-ball').value) || 0,
    shiny: $('pf-shiny').checked, moves, evs: st.evs, ivs: st.ivs,
    female: $('pf-female').checked, nature: st.nature,
    abilityNum: Number($('pf-ability').value) || 0,
    flags: P.flags,
    hpCur: hpMax, pp, nickname: $('pf-nickname').value.trim(),
  }, size);
  S.pcBuf.set(rec, pcRecOff(P.box * 30 + P.pos));
  S.pcDirty = true; S.dirty = true;
  renderPcBox(); updatePcMeta();
  closePcModal();
  toast(`${spName(P.spId)} guardado en ${S.pcNames[P.box]} · hueco ${P.pos + 1} (se escribe al exportar)`);
});

/* liberar (doble clic de confirmación) */
$('pcm-delete').addEventListener('click', () => {
  if (P.creating) return;
  if (!$('pcm-delete').classList.contains('armed')) {
    $('pcm-delete').classList.add('armed');
    $('pcm-delete').textContent = '¿Seguro? Toca otra vez';
    setTimeout(() => { $('pcm-delete').classList.remove('armed'); $('pcm-delete').textContent = 'Liberar hueco'; }, 3000);
    return;
  }
  S.pcBuf.fill(0, pcRecOff(P.box * 30 + P.pos), pcRecOff(P.box * 30 + P.pos) + pcSize());
  S.pcDirty = true; S.dirty = true;
  renderPcBox(); updatePcMeta();
  closePcModal();
  toast(`Hueco ${P.pos + 1} de ${S.pcNames[P.box]} liberado (se escribe al exportar)`);
});

/* ================= retirar de la caja al equipo =================
   Reconstruye un registro de 104 B desde el registro PC (38/31/21 B): especie,
   objeto, EXP→nivel, ball, shiny, movimientos (+PP base), IVs, EVs, género,
   naturaleza (byte bajo del PID coherente), habilidad y stats recalculados.
   El OT se clona de un miembro del equipo (o del entrenador si está vacío) y el
   PID alto se genera aleatorio — campos que el formato PC no guarda. */
function withdrawToParty() {
  if (!S.pcEditable) { toastPcRo(); return; }
  if (S.party.length >= 6) { toast('El equipo está lleno (6/6): libera un hueco antes de retirar', 4000); return; }
  const m = pcRecordAt(P.box * 30 + P.pos);
  if (!m || !m.species) return;
  const raw = newRecordBase();
  if (!raw) return;
  const spId = m.species;
  const sp = QZ.species[spId - 1];
  const level = Math.max(1, Math.min(100, qzLevelForExp(m.exp)));
  // naturaleza + género coherentes reescribiendo el byte bajo del PID
  const gb = sp ? sp[12] : 255;
  let pidLow = m.nature || 0;
  if (gb !== 255 && gb !== 0 && gb !== 254) {
    for (let b = m.nature || 0; b < 256; b += 25) {
      if (qzIsFemale(b, gb) === m.female) { pidLow = b; break; }
    }
  }
  const ivs = m.ivs.slice();
  const evs = m.evs.slice();
  const base = sp ? [sp[3], sp[4], sp[5], sp[6], sp[7], sp[8]] : [50, 50, 50, 50, 50, 50];
  const stats = qzCalcStats(base, level, ivs, evs, m.nature || 0);
  const hi = (Math.random() * 0x1000000) >>> 0;
  writeMonData(raw, {
    spId, nick: (m.nickname || spName(spId)).slice(0, 10),
    level, pid: (((hi << 8) >>> 0) | pidLow) >>> 0,
    shiny: m.shiny, abilityNum: m.abilityNum || 0,
    item: m.item || 0, ball: m.ball || 0, friendship: 70,
    ivs, evs, moves: m.moves.slice(), stats,
  });
  S.party.push(raw);
  S.pcBuf.fill(0, pcRecOff(P.box * 30 + P.pos), pcRecOff(P.box * 30 + P.pos) + pcSize());
  S.pcDirty = true; S.dirty = true;
  renderPcBox(); updatePcMeta(); renderParty();
  closePcModal();
  toast(`${spName(spId)} retirado al equipo (posición ${S.party.length}) · se escribe al exportar`, 4000);
}
$('pcm-withdraw').addEventListener('click', withdrawToParty);

/* pickers del PC (reutilizan la ventana genérica con el estado P) */
$('pf-species-btn').addEventListener('click', () => {
  openPicker({
    title: 'Elegir especie',
    placeholder: 'Buscar por nombre, nº de Dex nacional o id interno…',
    foot: 'El id interno es el que se guarda en el .sav',
    groups(qry) {
      const all = QZ.species.map((s, k) => ({ id: k + 1, s, dex: s ? (s[13] || 0) : 0 }))
        .filter(({ s }) => s);
      const list = qry ? all.filter(({ id, s, dex }) => (s && matchQ(qry, s[0])) || matchDex(qry, dex) || (/^\d+$/.test(normQ(qry).trim()) && String(id) === normQ(qry).trim())) : all;
      const conDex = list.filter(x => x.dex).sort((a, b) => a.dex - b.dex || a.id - b.id);
      const formas = list.filter(x => !x.dex).sort((a, b) => a.id - b.id);
      const g = [];
      if (conDex.length) g.push({ label: qry ? `${conDex.length} con Dex nacional` : 'Pokédex nacional',
        rows: conDex.map(({ id, s, dex }) => ({ id, get img() { return speciesRowHtml(id); }, title: `#${dex} ${escapeHtml(s[0])}`, sub: id !== dex ? `id interno ${id}` : '', chip: `<span class="pick-chips">${typeChips(s)}</span>` })) });
      if (formas.length) g.push({ label: qry ? `${formas.length} Formas Quetzal` : 'Formas Quetzal (sin Dex nacional)',
        rows: formas.map(({ id, s }) => ({ id, get img() { return speciesRowHtml(id); }, title: escapeHtml(s[0]), sub: `id interno ${id}`, chip: `<span class="pick-chips">${typeChips(s)}</span>` })) });
      return g;
    },
    onPick: (r) => setPcSpecies(r.id),
  });
});
$('pf-item-btn').addEventListener('click', () => {
  openPicker({
    title: 'Elegir objeto', placeholder: 'Buscar objeto (español o inglés)…', foot: `${QZ.items.filter(Boolean).length} objetos`,
    groups(q) {
      const rows = [];
      if (!q || 'ninguno'.includes(q) || 'sin'.startsWith(q) || 'none'.startsWith(q)) rows.push({ id: 0, img: itemDot(), title: '(ninguno)', sub: 'quitar el objeto' });
      for (let id = 1; id <= QZ.items.length; id++) {
        if (!QZ.items[id - 1]) continue;
        if (!q || matchQ(q, itName(id), itNameEn(id)) || matchDex(q, id)) rows.push({ id, img: itemDot(), title: `${escapeHtml(itName(id))} <small class="mv-en">${escapeHtml(itNameEn(id))}</small>`, sub: `#${id}` });
      }
      return [{ label: q ? `${rows.length} resultados` : 'Todos los objetos', rows }];
    },
    onPick: (r) => { P.item = r.id; updatePcItemBtn(); },
  });
});
function openPcMovePicker(slot) {
  const L = learnOf(P.spId);
  const current = P.moves[slot];
  openPicker({
    title: `Movimiento ${slot + 1} de 4`,
    placeholder: 'Buscar movimiento por nombre o número (busca en los 848)…',
    foot: 'Sin búsqueda: lo que la especie aprende (nivel, Evo. y tutor NOVO MOV.). Los PP se asignan solos.',
    groups(q) {
      if (q) {
        const mvs = allMoveRowsFiltered(q);
        return [{ label: `${mvs.length} de ${QZ.moves.length} movimientos`, rows: mvs.map(mv => moveRow(mv, inLearn(L, mv) ? (L.lv.find(e => e.mv === mv) || { lv: -1 }).lv : -2)) }];
      }
      const g = [];
      if (L) {
        g.push({ label: `Por nivel / Evo. (${L.lv.length})`, rows: L.lv.map(e => moveRow(e.mv, e.lv)) });
        g.push({ label: `Tutor · NOVO MOV. (${L.tu.length})`, rows: L.tu.map(mv => moveRow(mv, -1)) });
      } else {
        g.push({ label: `Todos los movimientos (${QZ.moves.length})`, rows: Array.from({ length: QZ.moves.length }, (_, k) => moveRow(k + 1, -2)) });
      }
      if (current && (!L || !inLearn(L, current))) g.push({ label: 'En uso (no aprendible)', rows: [moveRow(current, -2)] });
      return g;
    },
    onPick: (r) => { P.moves[slot] = r.id; renderPcMoveBtns(); },
  });
  const idx = pick.rows.findIndex(r => r.id === current);
  if (idx > 0) setActivePick(idx, 'center');
}

/* eventos del modal PC */
$('pcm-close').addEventListener('click', closePcModal);
$('pcmodal').addEventListener('mousedown', (e) => { if (e.target === $('pcmodal')) closePcModal(); });
$('pf-level').addEventListener('input', recalcPcModal);
$('pf-nature').addEventListener('change', recalcPcModal);
document.querySelector('#pf-stats tbody').addEventListener('input', recalcPcModal);
$('pf-shiny').addEventListener('change', () => {
  const url = spriteUrl(P.spId, $('pf-shiny').checked);
  if (url) $('pcm-sprite').src = url;
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($('pick').classList.contains('open')) return; // el picker ya maneja el Escape
  if ($('pcmodal').classList.contains('open')) closePcModal();
});

/* ================= ventanas y teclado móvil =================
   Al abrirse el teclado, el viewport VISUAL se encoge. Las ventanas (modal, buscador,
   texto) se fijan a ese rectángulo, así el contenido no se desplaza ni queda tapado. */
(function () {
  const OVERLAYS = ['modal', 'pcmodal', 'pick', 'txtbox'].map(id => $(id));
  const vv = window.visualViewport;
  function sync() {
    OVERLAYS.forEach(el => {
      if (el.classList.contains('open') && vv) {
        el.style.top = vv.offsetTop + 'px';
        el.style.height = vv.height + 'px';
        el.style.bottom = 'auto';
      } else {
        el.style.top = el.style.height = el.style.bottom = '';
      }
    });
  }
  let raf = 0;
  const later = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(sync); };
  if (vv) { vv.addEventListener('resize', later); vv.addEventListener('scroll', later); }
  const mo = new MutationObserver(sync);
  OVERLAYS.forEach(el => mo.observe(el, { attributes: true, attributeFilter: ['class'] }));
})();

/* ================= learnsets ================= */
function learnOf(spId) {
  if (!QZ.learn || !spId || (!QZ.learn.lvl[spId - 1] && !QZ.learn.tut[spId - 1])) return null;
  const lv = (QZ.learn.lvl[spId - 1] || '').split(',').filter(Boolean)
    .map(s => { const p = s.split('-'); return { lv: Number(p[0]), mv: Number(p[1]) }; });
  const tu = (QZ.learn.tut[spId - 1] || '').split(',').filter(Boolean).map(Number);
  return (lv.length || tu.length) ? { lv, tu } : null;
}
function inLearn(L, mv) {
  if (!L) return false;
  return L.lv.some(e => e.mv === mv) || L.tu.includes(mv);
}

function defaultMoves(spId, level) {
  const L = learnOf(spId);
  if (!L) return [0, 0, 0, 0];
  const upto = L.lv.filter(e => e.lv >= 1 && e.lv <= level).map(e => e.mv);
  const list = (upto.length >= 4 ? upto : upto.concat(L.lv.filter(e => e.lv === 0).map(e => e.mv))).slice(-4);
  return [0, 1, 2, 3].map(k => list[k] || 0);
}

/* ================= PICKER: ventana de búsqueda genérica ================= */
/* Lista virtualizada: solo existen en el DOM las filas visibles (+ un margen), con altura
   fija. Así abrir el buscador de 1528 especies / 848 movimientos / 830 objetos cuesta lo
   mismo que abrir uno de 10 filas, y solo se piden las imágenes que se ven. */
const ROW_H = 56, GROUP_H = 40, OVERSCAN = 6;
const pick = { cfg: null, rows: [], active: 0, items: [], rowItem: [], nodes: new Map(), raf: 0, timer: 0 };
const pickBody = $('pick-body');
const pickList = document.createElement('div');
pickList.className = 'pick-list';
pickBody.appendChild(pickList);

function openPicker(cfg) {
  pick.cfg = cfg;
  $('pick-title').textContent = cfg.title;
  $('pick-input').value = '';
  $('pick-foot').textContent = cfg.foot || '';
  $('pick-input').placeholder = cfg.placeholder || 'Buscar por nombre o número…';
  renderPick('');
  $('pick').classList.add('open');
  document.body.style.overflow = 'hidden';
  paintPick();                                   // ya con tamaño real
  // en móvil no se abre el teclado solo: así la lista aparece al instante y nada «salta»
  if (!window.matchMedia('(pointer: coarse)').matches) {
    setTimeout(() => $('pick-input').focus({ preventScroll: true }), 30);
  }
}
function closePicker() {
  if (!$('pick').classList.contains('open')) return;
  clearTimeout(pick.timer);
  cancelAnimationFrame(pick.raf);
  $('pick-input').blur();
  $('pick').classList.remove('open');
  // liberar todo el DOM y los datos de la lista
  pickList.textContent = '';
  pick.nodes.clear(); pick.items = []; pick.rowItem = []; pick.rows = []; pick.cfg = null;
  if (!$('modal').classList.contains('open')) document.body.style.overflow = '';
  else document.body.style.overflow = 'hidden'; // el modal sigue abierto debajo
}
function pickRowInner(r) {
  return `${r.img ? `<span class="pick-img">${r.img}</span>` : '<span class="pick-img pick-img-empty"></span>'}
    <span class="pick-txt"><span class="pick-name">${r.title}</span>${r.sub ? `<span class="pick-sub">${r.sub}</span>` : ''}</span>
    ${r.badge ? `<span class="pick-badge">${r.badge}</span>` : ''}
    ${r.chip || ''}`;
}
function makePickNode(i) {
  const it = pick.items[i];
  let el;
  if (it.group) {
    el = document.createElement('div');
    el.className = 'pick-group';
    el.innerHTML = it.label;
  } else {
    el = document.createElement('button');
    el.type = 'button';
    el.className = 'pick-row' + (it.idx === pick.active ? ' active' : '');
    el.dataset.idx = it.idx;
    el.innerHTML = pickRowInner(it.r);
  }
  el.style.height = it.h + 'px';
  el.style.transform = `translateY(${it.y}px)`;
  return el;
}
/* pinta solo la ventana visible: busca por bisección el primer elemento en pantalla */
function paintPick() {
  const items = pick.items;
  if (!items.length) return;
  const top = pickBody.scrollTop;
  const vh = pickBody.clientHeight || 480;
  let lo = 0, hi = items.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (items[mid].y + items[mid].h <= top) lo = mid + 1; else hi = mid; }
  const start = Math.max(0, lo - OVERSCAN);
  let end = lo;
  while (end < items.length && items[end].y < top + vh) end++;
  end = Math.min(items.length, end + OVERSCAN);
  for (const [i, el] of pick.nodes) {
    if (i < start || i >= end) { el.remove(); pick.nodes.delete(i); }
  }
  const frag = document.createDocumentFragment();
  for (let i = start; i < end; i++) {
    if (pick.nodes.has(i)) continue;
    const el = makePickNode(i);
    pick.nodes.set(i, el);
    frag.appendChild(el);
  }
  if (frag.childNodes.length) pickList.appendChild(frag);
}
function schedulePaint() {
  if (pick.raf) return;
  pick.raf = requestAnimationFrame(() => { pick.raf = 0; paintPick(); });
}
function renderPick(query) {
  const q = normQ(query).trim();
  const groups = pick.cfg.groups(q);
  pick.rows = []; pick.items = []; pick.rowItem = []; pick.active = 0;
  let y = 0;
  groups.forEach(g => {
    if (!g.rows.length) return;
    pick.items.push({ group: true, label: g.label, y, h: GROUP_H });
    y += GROUP_H;
    for (const r of g.rows) {
      const idx = pick.rows.length;
      pick.rows.push(r);
      pick.rowItem.push(pick.items.length);
      pick.items.push({ idx, r, y, h: ROW_H });
      y += ROW_H;
    }
  });
  pick.nodes.clear();
  pickList.textContent = '';
  if (!pick.items.length) {
    pickList.style.height = 'auto';
    pickList.innerHTML = '<div class="pick-empty">Sin resultados</div>';
  } else {
    pickList.style.height = y + 'px';
  }
  pickBody.scrollTop = 0;
  paintPick();
}
/* mode: 'nearest' (flechas), 'center' (al abrir sobre el valor actual), 'none' (ratón encima) */
function setActivePick(i, mode = 'nearest') {
  if (!pick.rows.length) return;
  const prev = pick.nodes.get(pick.rowItem[pick.active]);
  if (prev) prev.classList.remove('active');
  pick.active = Math.max(0, Math.min(pick.rows.length - 1, i));
  const it = pick.items[pick.rowItem[pick.active]];
  if (mode !== 'none') {
    const vh = pickBody.clientHeight || 480;
    const top = pickBody.scrollTop;
    if (mode === 'center') pickBody.scrollTop = Math.max(0, it.y - vh / 2 + it.h / 2);
    else if (it.y < top + 2) {
      const above = pick.items[pick.rowItem[pick.active] - 1];
      pickBody.scrollTop = above && above.group ? above.y : it.y;   // deja ver la cabecera del grupo
    } else if (it.y + it.h > top + vh) pickBody.scrollTop = it.y + it.h - vh;
  }
  paintPick();
  const cur = pick.nodes.get(pick.rowItem[pick.active]);
  if (cur) cur.classList.add('active');
}
function confirmPick(i) {
  const r = pick.rows[i];
  if (!r) return;
  const cfg = pick.cfg;
  closePicker();
  cfg.onPick(r);
}
// la búsqueda espera 60 ms tras la última tecla (no recalcula en cada letra)
$('pick-input').addEventListener('input', (e) => {
  clearTimeout(pick.timer);
  const v = e.target.value;
  pick.timer = setTimeout(() => { pick.timer = 0; if (pick.cfg) renderPick(v); }, 60);
});
function flushPick() {
  if (!pick.timer) return;
  clearTimeout(pick.timer); pick.timer = 0;
  if (pick.cfg) renderPick($('pick-input').value);
}
$('pick-input').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); flushPick(); setActivePick(pick.active + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); flushPick(); setActivePick(pick.active - 1); }
  else if (e.key === 'Enter') { e.preventDefault(); flushPick(); confirmPick(pick.active); }
  else if (e.key === 'Escape') { e.stopPropagation(); closePicker(); }
});
pickBody.addEventListener('scroll', schedulePaint, { passive: true });
pickBody.addEventListener('click', (e) => {
  const row = e.target.closest('.pick-row');
  if (row) confirmPick(Number(row.dataset.idx));
});
pickBody.addEventListener('mousemove', (e) => {
  const row = e.target.closest('.pick-row');
  if (row && Number(row.dataset.idx) !== pick.active) setActivePick(Number(row.dataset.idx), 'none');
});
$('pick-close').addEventListener('click', closePicker);
$('pick').addEventListener('mousedown', (e) => { if (e.target === $('pick')) closePicker(); });

/* ---------- picker de especie ----------
   Identidad separada: el id INTERNO (posición del array) es lo que se escribe
   en el .sav; el Dex NACIONAL (species[][13]) solo se muestra y ordena; el
   sprite usa species[][14] (forma concreta de PokeAPI). */
function speciesRowHtml(id) {
  return spriteImg(id, false, spName(id), 'pick-sprite');
}
function spDex(id) { const s = QZ.species[id - 1]; return s ? (s[13] || 0) : 0; }
function openSpeciesPicker(current) {
  openPicker({
    title: 'Elegir especie',
    placeholder: 'Buscar por nombre, nº de Dex nacional o id interno…',
    foot: `${QZ.species.reduce((n, s) => n + (s && s[13] ? 1 : 0), 0)} especies con Dex nacional ·
           ${QZ.species.reduce((n, s) => n + (s && !s[13] ? 1 : 0), 0)} Formas Quetzal · el id interno es el que se guarda en el .sav`,
    groups(q) {
      const all = QZ.species.map((s, k) => ({ id: k + 1, s, dex: s ? (s[13] || 0) : 0 }));
      let list;
      if (!q) {
        list = all;
      } else {
        list = all.filter(({ id, s, dex }) =>
          (s && matchQ(q, s[0])) || matchDex(q, dex) || /^\d+$/.test(normQ(q).trim()) && String(id) === normQ(q).trim());
      }
      const conDex = list.filter(x => x.dex).sort((a, b) => a.dex - b.dex || a.id - b.id);
      const formas = list.filter(x => !x.dex).sort((a, b) => a.id - b.id);
      const g = [];
      if (!q) {
        if (conDex.length) g.push({
          label: 'Pokédex nacional',
          rows: conDex.map(({ id, s, dex }) => ({
            id,
            get img() { return speciesRowHtml(id); },
            title: `#${dex} ${escapeHtml(s[0])}`,
            sub: id !== dex ? `id interno ${id}` : '',
            chip: `<span class="pick-chips">${typeChips(s)}</span>`,
          })),
        });
        if (formas.length) g.push({
          label: 'Formas Quetzal (sin Dex nacional)',
          rows: formas.map(({ id, s }) => ({
            id,
            get img() { return speciesRowHtml(id); },
            title: `${escapeHtml(s[0])}`,
            sub: `id interno ${id}`, chip: `<span class="pick-chips">${typeChips(s)}</span>`,
          })),
        });
        return g;
      }
      if (conDex.length) g.push({
        label: `${conDex.length} con Dex nacional`,
        rows: conDex.map(({ id, s, dex }) => ({
          id, get img() { return speciesRowHtml(id); },
          title: `#${dex} ${escapeHtml(s[0])}`,
          sub: id !== dex ? `id interno ${id}` : '',
          chip: `<span class="pick-chips">${typeChips(s)}</span>`,
        })),
      });
      if (formas.length) g.push({
        label: `${formas.length} Formas Quetzal`,
        rows: formas.map(({ id, s }) => ({
          id, get img() { return speciesRowHtml(id); }, title: `${escapeHtml(s[0])}`,
          sub: `id interno ${id}`, chip: `<span class="pick-chips">${typeChips(s)}</span>`,
        })),
      });
      return g;
    },
    onPick: (r) => setModalSpecies(r.id),
  });
  if (current) {
    const idx = pick.rows.findIndex(r => r.id === current);
    if (idx > 0) setActivePick(idx, 'center');
  }
}

/* ---------- picker de movimiento ---------- */
function moveRow(mv, how) {
  const mvD = QZ.moves[mv - 1];
  const type = mvD ? mvD[1] : 'mystery';
  const cat = mvD ? mvD[2] : 'status';
  const badge = how > 0 ? `Nv. ${how}` : how === 0 ? 'Evo.' : how === -1 ? 'Tutor' : 'En uso';
  return {
    id: mv,
    img: typeDot(type),
    title: `${escapeHtml(mvName(mv))} <small class="mv-en">${escapeHtml(mvNameEn(mv))}</small>`,
    sub: `#${mv} · precisión ${mvD && mvD[4] != null ? mvD[4] : '—'} · poder ${mvD && mvD[3] != null ? mvD[3] : '—'}`,
    badge,
    chip: `<span class="pick-chips"><span class="type-chip" style="background:${TYPE_COLOR[type] || '#888'}">${typeEs[type] || type}</span><span class="cat-chip">${CAT_ES[cat] || ''}</span></span>`,
  };
}
function allMoveRowsFiltered(q) {
  const rows = [];
  for (let mv = 1; mv <= QZ.moves.length; mv++) {
    if (!q) break;
    const hit = matchQ(q, mvName(mv), mvNameEn(mv)) || matchDex(q, mv);
    if (hit) rows.push(mv);
  }
  return rows;
}
function openMovePicker(slot) {
  const spId = M.spId;
  const L = learnOf(spId);
  const current = M.moves[slot];
  openPicker({
    title: `Movimiento ${slot + 1} de 4`,
    placeholder: 'Buscar movimiento por nombre o número (busca en los 848)…',
    foot: 'Sin búsqueda: lo que la especie aprende (nivel, Evo. y tutor NOVO MOV.). Los PP se asignan solos.',
    groups(q) {
      if (q) {
        const mvs = allMoveRowsFiltered(q);
        return [{
          label: `${mvs.length} de ${QZ.moves.length} movimientos`,
          rows: mvs.map(mv => moveRow(mv, inLearn(L, mv) ? (L.lv.find(e => e.mv === mv) || { lv: -1 }).lv : -2)),
        }];
      }
      const g = [];
      if (L) {
        g.push({ label: `Por nivel / Evo. (${L.lv.length})`, rows: L.lv.map(e => moveRow(e.mv, e.lv)) });
        g.push({ label: `Tutor · NOVO MOV. (${L.tu.length})`, rows: L.tu.map(mv => moveRow(mv, -1)) });
      } else {
        g.push({ label: `Todos los movimientos (${QZ.moves.length})`,
          rows: Array.from({ length: QZ.moves.length }, (_, k) => moveRow(k + 1, -2)) });
      }
      if (current && (!L || !inLearn(L, current))) g.push({ label: 'En uso (no aprendible)', rows: [moveRow(current, -2)] });
      return g;
    },
    onPick: (r) => setModalMove(slot, r.id),
  });
  const idx = pick.rows.findIndex(r => r.id === current);
  if (idx > 0) setActivePick(idx, 'center');
}

/* ---------- picker de objeto ---------- */
function openItemPicker() {
  const current = M.item;
  openPicker({
    title: 'Elegir objeto',
    placeholder: 'Buscar objeto (español o inglés)…',
    foot: `${QZ.items.filter(Boolean).length} objetos`,
    groups(q) {
      const rows = [];
      if (!q || 'ninguno'.includes(q) || 'sin'.startsWith(q) || 'none'.startsWith(q)) {
        rows.push({ id: 0, img: itemDot(), title: '(ninguno)', sub: 'quitar el objeto' });
      }
      for (let id = 1; id <= QZ.items.length; id++) {
        if (!QZ.items[id - 1]) continue;
        const hit = !q || matchQ(q, itName(id), itNameEn(id)) || matchDex(q, id);
        if (hit) rows.push({
          id,
          img: itemDot(),
          title: `${escapeHtml(itName(id))} <small class="mv-en">${escapeHtml(itNameEn(id))}</small>`,
          sub: `#${id}`,
        });
      }
      return [{ label: q ? `${rows.length} resultados` : 'Todos los objetos', rows }];
    },
    onPick: (r) => setModalItem(r.id),
  });
  const idx = pick.rows.findIndex(r => r.id === current);
  if (idx > 0) setActivePick(idx, 'center');
}

/* ================= modal de edición ================= */
function fillSelect(sel, opts, value) {
  sel.innerHTML = opts.map(o => `<option value="${o.v}"${o.v === value ? ' selected' : ''}>${escapeHtml(o.t)}</option>`).join('');
}

function updateSpeciesBtn() {
  // solo el id interno: nombre y tipos ya salen en la cabecera del modal
  $('f-species-btn').title = spName(M.spId);
  $('f-species-btn').innerHTML = `<span class="pick-btn-img">${spriteImg(M.spId, false, spName(M.spId))}</span>
    <span class="pick-btn-txt"><b>ID interno ${M.spId}</b></span>`;
}
function updateItemBtn() {
  $('f-item-btn').innerHTML = `<span class="pick-btn-img sm">${itemDot()}</span>
    <span class="pick-btn-txt"><b>${escapeHtml(M.item ? itName(M.item) : '(ninguno)')}</b>
    <small>${M.item ? '#' + M.item : 'toca para elegir'}</small></span>`;
}
function moveBtnHtml(mv) {
  if (!mv) return `<span class="pick-btn-img sm">${itemDot()}</span>
    <span class="pick-btn-txt"><b>(ninguno)</b><small>toca para elegir</small></span>`;
  const mvD = QZ.moves[mv - 1];
  const type = mvD ? mvD[1] : 'mystery';
  return `<span class="pick-btn-img sm">${typeDot(type)}</span>
    <span class="pick-btn-txt"><b>${escapeHtml(mvName(mv))}</b>
    <span class="type-row"><span class="type-chip" style="background:${TYPE_COLOR[type] || '#888'}">${typeEs[type] || type}</span></span></span>`;
}
function renderMoveBtns() {
  $('f-moves').innerHTML = [0, 1, 2, 3].map(k =>
    `<button class="pick-btn mv-btn" type="button" data-slot="${k}">${moveBtnHtml(M.moves[k])}</button>`).join('');
  document.querySelectorAll('.mv-btn').forEach(btn =>
    btn.addEventListener('click', () => openMovePicker(Number(btn.dataset.slot))));
}

function setModalSpecies(spId) {
  M.spId = spId;
  const sp = QZ.species[spId - 1];
  $('m-sprite').src = spriteUrl(spId, $('f-shiny').checked) || PLACEHOLDER;
  $('m-types').innerHTML = typeChips(sp);
  updateSpeciesBtn();
  fillGender(spId, 0);
  fillAbility(spId, 0);
  if (M.creating) {
    // en creación, al cambiar especie se reinician los movimientos a los
    // defaults de la nueva (si no, arrastraría los de la especie anterior)
    M.moves = defaultMoves(spId, Number($('f-level').value) || 50);
    renderMoveBtns();
  }
  recalcModal();
}
function setModalItem(id) { M.item = id; updateItemBtn(); }
function setModalMove(slot, mv) { M.moves[slot] = mv; renderMoveBtns(); }

function openModal(i) {
  const creating = i < 0 || !S.party[i] || !S.party[i].length || !S.save.parsePartyRecord(S.party[i]).species;
  S.editing = i;
  M.creating = creating;
  S.deleting = -1;
  $('m-delete').classList.remove('armed');
  $('m-delete').textContent = 'Eliminar';
  $('m-delete').disabled = creating;

  const m = creating ? null : S.save.parsePartyRecord(S.party[i]);
  M.spId = creating ? 1 : m.species;
  M.item = creating ? 0 : m.item;
  M.moves = creating ? [0, 0, 0, 0] : m.moves.slice();
  const spId = M.spId;
  const sp = QZ.species[spId - 1];

  // cabecera
  $('m-sprite').src = spriteUrl(spId, m && m.shiny) || PLACEHOLDER;
  $('m-title').textContent = creating ? 'Añadir Pokémon' : (m.nickname || spName(spId));
  $('m-types').innerHTML = typeChips(sp);

  // identidad
  updateSpeciesBtn();
  updateItemBtn();
  $('f-nickname').value = creating ? '' : m.nickname;
  $('f-level').value = creating ? 50 : m.level;
  fillGender(spId, creating ? 0 : (m.pid & 0xFF));
  fillSelect($('f-nature'), QZ.natures.map((n, k) => ({ v: k, t: `${k} ${natName(k)}` })), creating ? 0 : m.nature);
  fillAbility(spId, creating ? 0 : m.abilityNum);
  fillSelect($('f-ball'), QZ.balls.map((n, k) => ({ v: k, t: ballName(k) })), creating ? 3 : Math.min(m.ball, 25));
  $('f-friendship').value = creating ? 70 : m.friendship;
  $('f-shiny').checked = creating ? false : m.shiny;
  // creación múltiple: cuántos copias se crearán (tope = huecos libres del equipo)
  const libres = 6 - S.party.length;
  $('fld-qty').hidden = !creating;
  if (creating) {
    $('f-qty').max = String(Math.max(1, libres));
    $('f-qty').value = '1';
    $('f-qty').title = libres > 1 ? `Hasta ${libres} (huecos libres)` : 'Solo hay 1 hueco libre';
  }

  // stats
  const tbody = $('stats-table').tBodies[0];
  tbody.querySelector('.row-base').innerHTML = `<td>Base</td>` + (sp
    ? [sp[3], sp[4], sp[5], sp[6], sp[7], sp[8]].map(v => `<td>${v}</td>`).join('') : '<td colspan="6">—</td>');
  tbody.querySelector('.row-iv').innerHTML = `<td>IVs <small>(0-31)</small></td>` + [0, 1, 2, 3, 4, 5].map(k =>
    `<td><input type="number" min="0" max="31" data-f="iv" data-k="${k}" value="${creating ? 0 : m.ivs[k]}"></td>`).join('');
  tbody.querySelector('.row-ev').innerHTML = `<td>EVs <small>(0-252)</small></td>` + [0, 1, 2, 3, 4, 5].map(k =>
    `<td><input type="number" min="0" max="252" step="4" data-f="ev" data-k="${k}" value="${creating ? 0 : m.evs[k]}"></td>`).join('');

  // movimientos (crear: defaults por nivel; editar: los del registro)
  if (creating) M.moves = defaultMoves(M.spId, Number($('f-level').value) || 50);
  renderMoveBtns();

  recalcModal();
  $('modal').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeModal() {
  $('modal').classList.remove('open');
  document.body.style.overflow = '';
  S.editing = -1; M.creating = false;
}

function fillGender(spId, pidLow) {
  const gb = QZ.species[spId - 1] ? QZ.species[spId - 1][12] : 255;
  const gSel = $('f-gender');
  const opts = gb === 255 ? [{ v: 3, t: 'Sin género' }]
    : gb === 0 ? [{ v: 2, t: 'Solo ♂' }]
    : gb === 254 ? [{ v: 1, t: 'Solo ♀' }]
    : [{ v: 0, t: '♂ Macho' }, { v: 1, t: '♀ Hembra' }];
  const val = gb === 255 ? 3 : gb === 0 ? 2 : gb === 254 ? 1 : (qzIsFemale(pidLow, gb) ? 1 : 0);
  fillSelect(gSel, opts, val);
  gSel.disabled = (gb === 255 || gb === 0 || gb === 254);
}
function fillAbility(spId, num) {
  const sp = QZ.species[spId - 1];
  const abil = sp ? [[sp[9], 0], [sp[10], 1], [sp[11], 2]] : [];
  fillSelect($('f-ability'), abil.filter(a => a[0]).map(a =>
    ({ v: a[1], t: (a[1] === 2 ? 'OCULTA: ' : '') + abName(a[0]) })), num);
}

/* stats del modal: se calculan con los valores del formulario (sin tocar el save hasta Guardar) */
function modalState() {
  const spId = M.spId || 1;
  const sp = QZ.species[spId - 1];
  const ivs = [...document.querySelectorAll('#stats-table [data-f="iv"]')].map(el => Math.max(0, Math.min(31, Number(el.value) || 0)));
  const evs = [...document.querySelectorAll('#stats-table [data-f="ev"]')].map(el => Math.max(0, Math.min(252, Number(el.value) || 0)));
  const level = Math.max(1, Math.min(100, Number($('f-level').value) || 1));
  const nature = Number($('f-nature').value) || 0;
  const base = sp ? [sp[3], sp[4], sp[5], sp[6], sp[7], sp[8]] : [0, 0, 0, 0, 0, 0];
  return { spId, sp, ivs, evs, level, nature, base, stats: qzCalcStats(base, level, ivs, evs, nature) };
}

/* validación visual IVs/EVs: bordes rojos + contador de suma */
function evInvalid() {
  const bad = [];
  document.querySelectorAll('#stats-table [data-f="iv"]').forEach(el => {
    const v = Number(el.value);
    const badNow = !Number.isFinite(v) || v < 0 || v > 31 || el.value === '';
    el.classList.toggle('invalid', badNow);
    if (badNow) bad.push(`IV ${STATN[Number(el.dataset.k)]}`);
  });
  let sum = 0;
  document.querySelectorAll('#stats-table [data-f="ev"]').forEach(el => {
    const v = Number(el.value);
    const badNow = !Number.isFinite(v) || v < 0 || v > 252 || el.value === '';
    el.classList.toggle('invalid', badNow);
    if (badNow) bad.push(`EV ${STATN[Number(el.dataset.k)]}`);
    if (Number.isFinite(v) && v > 0) sum += v;
  });
  const over = sum > 510;
  $('ev-total').textContent = `Σ EVs: ${sum}/510`;
  $('ev-total').classList.toggle('bad', over);
  if (over) bad.push(`suma de EVs ${sum} > 510`);
  return over || bad.length ? bad : null;
}

/* barra de EXP (nivel respecto a 100) */
function renderExp(level) {
  const pct = Math.max(0, Math.min(100, Math.round((level / 100) * 100)));
  $('exp-fill').style.width = pct + '%';
  $('exp-label').textContent = `Nv. ${level} · ${qzExpForLevel(level).toLocaleString('es')} EXP`;
  $('exp-pct').textContent = `${pct}% del nivel 100`;
  $('exp-fill').parentElement.setAttribute('aria-valuenow', pct);
}

/* radar hexagonal de stats (SVG, sin librerías) */
function renderRadarInto(svg, stats) {
  const cx = 110, cy = 96, R = 66;
  const pt = (k, frac) => {
    const a = (-90 + k * 60) * Math.PI / 180;
    return [cx + Math.cos(a) * R * frac, cy + Math.sin(a) * R * frac];
  };
  const max = Math.max(...stats, 100) * 1.05;
  let h = '';
  // anillos
  [0.25, 0.5, 0.75, 1].forEach(f => {
    const pts = [0, 1, 2, 3, 4, 5].map(k => pt(k, f).map(v => v.toFixed(1)).join(',')).join(' ');
    h += `<polygon points="${pts}" class="radar-ring${f === 1 ? ' outer' : ''}"/>`;
  });
  // ejes + etiquetas
  for (let k = 0; k < 6; k++) {
    const [x, y] = pt(k, 1);
    h += `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" class="radar-axis"/>`;
    const [lx, ly] = pt(k, 1.24);
    h += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" class="radar-lab" text-anchor="middle">${STAT_SHORT[k]} <tspan class="radar-val">${stats[k]}</tspan></text>`;
  }
  // polígono de stats
  const poly = stats.map((v, k) => pt(k, Math.min(1, v / max)).map(c => c.toFixed(1)).join(',')).join(' ');
  h += `<polygon points="${poly}" class="radar-poly"/>`;
  svg.innerHTML = h;
}
function renderRadar(stats) { renderRadarInto($('radar'), stats); }

function recalcModal() {
  const st = modalState();
  // fila Base SIEMPRE sincronizada con la especie actual (se puede cambiar en el picker)
  $('stats-table').querySelector('.row-base').innerHTML = `<td>Base</td>` + (st.sp
    ? [st.base[0], st.base[1], st.base[2], st.base[3], st.base[4], st.base[5]].map(v => `<td>${v}</td>`).join('')
    : '<td colspan="6">—</td>');
  $('stats-table').querySelector('.row-calc').innerHTML =
    `<td>Calculados</td>` + st.stats.map(v => `<td class="calc">${v}</td>`).join('');
  renderRadar(st.stats);
  renderExp(st.level);
  evInvalid();
  const gb = st.sp ? st.sp[12] : 255;
  if (gb !== 255 && gb !== 0 && gb !== 254) {
    // mantener género visible coherente si cambia la especie
    const want = $('f-gender').value;
    if (!$('f-gender').querySelector(`option[value="${want}"]`)) fillGender(st.spId, 0);
  }
}

/* eventos del modal */
$('f-species-btn').addEventListener('click', () => openSpeciesPicker(M.spId));
$('f-item-btn').addEventListener('click', openItemPicker);
$('f-shiny').addEventListener('change', () => {
  const url = spriteUrl(M.spId, $('f-shiny').checked);
  if (url) $('m-sprite').src = url;
  updateSpeciesBtn();
});
$('f-level').addEventListener('input', recalcModal);
document.querySelector('#stats-table tbody').addEventListener('input', recalcModal);
$('f-nature').addEventListener('change', recalcModal);
$('m-close').addEventListener('click', closeModal);
$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($('pick').classList.contains('open')) { closePicker(); return; }
  if ($('txtbox').classList.contains('open')) { closeTxtBox(); return; }
  if ($('modal').classList.contains('open')) closeModal();
});

/* guardar: escribir en S.party (raw 104 B) */
$('m-save').addEventListener('click', () => {
  let i = S.editing;
  if (i < 0 && !M.creating) return;
  const bad = evInvalid();
  if (bad) { toast('Valores fuera de rango: ' + bad.slice(0, 3).join(', ') + (bad.length > 3 ? '…' : ''), 3600); return; }
  const st = modalState();
  if (!st.spId) { toast('Elige una especie'); return; }

  // en creación: el slot destino es el primer vacío del equipo o una posición nueva
  if (M.creating) {
    const idx = S.party.findIndex(r => !S.save.parsePartyRecord(r).species);
    i = idx >= 0 ? idx : S.party.length;
  }
  const mOld = (!M.creating && S.party[i]) ? S.save.parsePartyRecord(S.party[i]) : null;

  // naturaleza + género coherentes reescribiendo el byte bajo del PID (doc/04)
  const wantNature = Number($('f-nature').value) || 0;
  const gb = st.sp ? st.sp[12] : 255;
  const gSelV = Number($('f-gender').value);
  let pidLow = wantNature;
  if (gb !== 255 && gb !== 0 && gb !== 254) {
    const female = M.creating ? (gSelV === 1) : qzIsFemale(mOld.pid & 0xFF, gb);
    for (let b = wantNature; b < 256; b += 25) {
      if (qzIsFemale(b, gb) === female) { pidLow = b; break; }
    }
  } // géneros fijos (♂/♀/sin género): el byte bajo de la naturaleza no afecta

  let raw;
  const qtyCrear = M.creating ? Math.max(1, Math.min(Number($('f-qty').max) || 1, Number($('f-qty').value) || 1)) : 1;
  for (let copia = 0; copia < qtyCrear; copia++) {
    if (M.creating) {
      // slot destino de esta copia: primer vacío del equipo o posición nueva (tope 6)
      if (S.party.length >= 6 && !S.party.some(r => !S.save.parsePartyRecord(r).species)) break;
      i = S.party.findIndex(r => !S.save.parsePartyRecord(r).species);
      if (i < 0) i = S.party.length;
      raw = newRecordBase();
      if (!raw) return;
      S.party[i] = raw; // slot vacío sobrescrito o posición nueva
      const hi = (Math.random() * 0x1000000) >>> 0; // PID alto aleatorio solo en creación
      writeMonData(raw, {
        spId: st.spId, nick: $('f-nickname').value.trim() || spName(st.spId).slice(0, 10),
        level: st.level, pid: (((hi << 8) >>> 0) | pidLow) >>> 0,
        shiny: $('f-shiny').checked, abilityNum: Number($('f-ability').value) || 0,
        item: M.item || 0, ball: Number($('f-ball').value) || 0,
        friendship: Number($('f-friendship').value) || 0,
        ivs: st.ivs, evs: st.evs, moves: M.moves.slice(), stats: st.stats,
      });
    } else {
      raw = S.party[i];
      writeMonData(raw, {
        spId: st.spId, nick: $('f-nickname').value.trim() || spName(st.spId).slice(0, 10),
        level: st.level, pid: ((mOld.pid & 0xFFFFFF00) | pidLow) >>> 0,
        shiny: $('f-shiny').checked, abilityNum: Number($('f-ability').value) || 0,
        item: M.item || 0, ball: Number($('f-ball').value) || 0,
        friendship: Number($('f-friendship').value) || 0,
        ivs: st.ivs, evs: st.evs, moves: M.moves.slice(), stats: st.stats,
      });
      break; // editar solo afecta a un registro
    }
  }

  S.dirty = true;
  renderParty();
  closeModal();
  toast(M.creating
    ? `${spName(st.spId)} ×${qtyCrear} añadido${qtyCrear === 1 ? '' : 's'} al equipo`
    : 'Cambios aplicados (se guardan al exportar)');
});

/* construir la base de un registro nuevo de 104 B:
   clona los metadatos de OT (0x10-0x27) de un miembro del equipo; si el equipo
   está vacío, reconstruye el OT desde los datos del entrenador (nombre + TID/SID). */
function newRecordBase() {
  const raw = new Uint8Array(QZS.SLOT_BYTES);
  const t = S.save.trainer();
  wrU32(raw, 0x04, (t.tid | (t.sid << 16)) >>> 0); // OT ID del entrenador
  const donor = S.party.find(r => rdU16(r, 0x28));
  if (donor) {
    raw.set(donor.subarray(0x10, 0x28), 0x10); // idioma + OT name + zona no documentada
    wrU32(raw, 0x54, (rdU32(donor, 0x54) & (~((3 << 28) >>> 0))) >>> 0); // conservar bits altos desconocidos, habilidad a 0
  } else {
    // sin donante: bytes 0x10-0x13 (idioma/zona no documentada) a 0 y OT = nombre del entrenador
    raw.set(qzEncodeText(t.name.slice(0, 7), 7), 0x14);
    wrU32(raw, 0x54, 0);
  }
  return raw;
}

/* escribir todos los campos editables de un registro de 104 B.
   o = { spId, nick, level, pid, shiny, abilityNum, item, ball, friendship, ivs, evs, moves, stats } */
function writeMonData(raw, o) {
  wrU16(raw, 0x28, o.spId);
  raw.set(qzEncodeText(o.nick, 10), 0x08);
  raw[0x58] = o.level;
  wrU32(raw, 0x2C, qzExpForLevel(o.level));
  wrU32(raw, 0x00, o.pid >>> 0);
  raw[0x13] = o.shiny ? (raw[0x13] | 0x08) : (raw[0x13] & ~0x08 & 0xFF);
  // habilidad: preservar el resto de la palabra 0x54 (bit 30 constante)
  const abw = rdU32(raw, 0x54);
  wrU32(raw, 0x54, ((abw & ~(3 << 28)) | ((o.abilityNum & 3) << 28)) >>> 0);
  wrU16(raw, 0x2A, o.item || 0);
  raw[0x32] = o.ball || 0;
  raw[0x31] = Math.max(0, Math.min(255, o.friendship | 0));
  // IVs / EVs
  const ivw = (rdU32(raw, 0x50) & ~((1 << 30) - 1)) >>> 0;
  let nw = 0; o.ivs.forEach((x, j) => { nw |= (x & 31) << (5 * j); });
  wrU32(raw, 0x50, (ivw | nw) >>> 0);
  o.evs.forEach((x, k) => { raw[0x40 + k] = x; });
  // movimientos + PP base (los PP no se editan en la UI)
  o.moves.forEach((mv, k) => {
    wrU16(raw, 0x34 + 2 * k, mv);
    raw[0x3C + k] = mv ? QZ.moves[mv - 1][5] : 0;
  });
  // stats recalculados + HP actual = máximo
  o.stats.forEach((v, k) => wrU16(raw, 0x5A + 2 * k, Math.min(v, 65535)));
  wrU16(raw, 0x23, o.stats[0]);
}

/* eliminar (doble clic de confirmación) */
$('m-delete').addEventListener('click', () => {
  const i = S.editing;
  if (i < 0) return;
  if (S.deleting !== i) {
    S.deleting = i;
    $('m-delete').classList.add('armed');
    $('m-delete').textContent = '¿Seguro? Toca otra vez';
    setTimeout(() => { if (S.deleting === i) { S.deleting = -1; $('m-delete').classList.remove('armed'); $('m-delete').textContent = 'Eliminar'; } }, 3000);
    return;
  }
  S.party.splice(i, 1);
  S.dirty = true;
  renderParty();
  closeModal();
  toast('Pokémon eliminado del equipo (se guarda al exportar)');
});

/* ================= equipo desde texto (formato tipo Showdown ampliado) =================
   Acepta español e inglés: especie, apodo, objeto, habilidad, nivel, naturaleza,
   EVs/IVs, amistad, shiny y movimientos. Solo añade hasta el nº de huecos libres. */
let LOOK = null;
function buildLookups() {
  if (LOOK) return LOOK;
  const species = {}, moves = {}, items = {}, abil = {}, nats = {};
  /* clave = tokKey (minúsculas, sin acentos ni signos): «Fake Out»→'fakeout' */
  /* especies: si varias formas comparten nombre (p. ej. «Garchomp» real vs
     Forma Quetzal duplicada), gana la que tiene Dex nacional (la base). */
  QZ.species.forEach((s, i) => {
    if (!s || !s[0]) return;
    const k = tokKey(s[0]);
    const cur = species[k];
    if (cur == null || (!QZ.species[cur - 1][13] && s[13])) species[k] = i + 1;
  });
  QZ.moves.forEach((m, i) => { if (m && m[0]) moves[tokKey(m[0])] = i + 1; });
  if (QZ.movesES) QZ.movesES.forEach((n, i) => { if (n) moves[tokKey(n)] = i + 1; });
  /* nombres EN oficiales (la ROM trunca: «ThnderusKick» → «Thunderous Kick»)
     para que el importador acepte equipos pegados en inglés correcto */
  if (QZ.movesEN) QZ.movesEN.forEach((n, i) => { if (n) moves[tokKey(n)] = i + 1; });
  QZ.items.forEach((n, i) => { if (n && i >= 0) addObjetoKeys(items, n, i + 1); });
  if (QZ.itemsES) QZ.itemsES.forEach((n, i) => { if (n && i >= 0) addObjetoKeys(items, n, i + 1); });
  Object.entries(QZ.abilities).forEach(([id, n]) => { if (n) abil[tokKey(n)] = Number(id); });
  if (QZ.abilitiesEN) Object.entries(QZ.abilitiesEN).forEach(([id, n]) => { if (n) abil[tokKey(n)] = Number(id); });
  /* nombres oficiales ES (names_es.js: veekun + PokeAPI gen 9) — el importador
     acepta «Intimidación», «Piel Tosca», «General Supremo», … */
  if (QZ.abilitiesES) Object.entries(QZ.abilitiesES).forEach(([id, n]) => { if (n && abil[tokKey(n)] == null) abil[tokKey(n)] = Number(id); });
  /* alias coloquiales frecuentes que la ROM no usa (el juego dice «Gafas
     Elección» / «Potencia», la gente escribe «Gafas Elegidas» / «Potencia Firme») */
  [['gafaselegidas', 'gafaseleccion'], ['gafasespeciales', 'gafaseleccion'],
   ['cintaelegida', 'cintaeleccion'], ['cintaelegidas', 'cintaeleccion'],
   ['panueloelegido', 'panueloeleccion'], ['panueloelegidos', 'panueloeleccion'],
  ].forEach(([a, b]) => { if (items[a] == null && items[b] != null) items[a] = items[b]; });
  [['potenciafirme', 'potencia']].forEach(([a, b]) => { if (abil[a] == null && abil[b] != null) abil[a] = abil[b]; });
  QZ.natures.forEach((n, k) => { nats[tokKey(n[0])] = k; });
  NATURES_ES.forEach((n, k) => { nats[tokKey(n)] = k; });
  return LOOK = { species, moves, items, abil, nats };
}
/* claves extra para objetos: «Baya Zidra» también debe encontrar «Zidra Berry»
   (y viceversa con los nombres EN): registro base + orden invertido + variantes
   baya↔berry. Solo se añaden claves nuevas; nunca se pisan las ya registradas. */
function addObjetoKeys(map, name, id) {
  const put = (k, v) => { if (k && map[k] == null) map[k] = v; };
  const base = tokKey(name);
  put(base, id);
  const words = name.trim().split(/\s+/);
  if (words.length < 2) return;
  put(tokKey(words.slice().reverse().join(' ')), id);            // «Zidra Baya»
  const swap = words.map(w => (/^baya$/i.test(w) ? 'Berry' : /^berry$/i.test(w) ? 'Baya' : w));
  put(tokKey(swap.join(' ')), id);                               // «Berry Zidra»
  put(tokKey(swap.slice().reverse().join(' ')), id);             // «Zidra Berry»
}
const tokKey = (s) => normQ(s).replace(/[^a-z0-9]/g, '');
/* búsqueda por clave exacta; si falla, prefijo único. Devuelve null si no hay match. */
function lookupFuzzy(map, name) {
  const k = tokKey(name);
  if (!k) return null;
  if (map[k] != null) return map[k];
  const hits = Object.keys(map).filter(key => key.startsWith(k));
  return hits.length === 1 ? map[hits[0]] : null;
}
function findSpeciesKey(name) {
  const L = buildLookups();
  const k = normQ(name).trim();
  if (/^#?\d+$/.test(k)) {
    const n = Number(k.replace('#', ''));
    const byDex = QZ.species.findIndex(s => s && s[13] === n);
    if (byDex >= 0) return byDex + 1;
    if (n >= 1 && n <= QZ.species.length) return n; // id interno
  }
  return lookupFuzzy(L.species, name) || 0;
}
/* claves de stat aceptadas (normalizadas, sin signos) → índice 0..5 */
const STAT_KEYS = { hp:0, ps:0, atk:1, ataque:1, atq:1, def:2, defensa:2, spe:3, vel:3, velocidad:3,
  spa:4, spatk:4, atesp:4, atqesp:4, ataqueesp:4, spd:5, spdef:5, sdef:5, defesp:5, defensaesp:5 };
function parseStatsLine(s, target, warns) {
  s.split('/').forEach(part => {
    const m = part.trim().match(/^(\d+)\s*(.*)$/);
    if (!m) return;
    const key = tokKey(m[2] || '');
    if (STAT_KEYS[key] == null) { warns.push(`stat no reconocida: «${part.trim()}»`); return; }
    target[STAT_KEYS[key]] = Math.max(0, Math.min(252, Number(m[1])));
  });
}
function parseTeamTxt(text) {
  const L = buildLookups();
  const mons = [], warnings = [];
  const blocks = text.split(/\n\s*\n/).map(b => b.split(/\r?\n/).map(l => l.trim()).filter(Boolean)).filter(b => b.length);
  for (const lines of blocks) {
    const p = { nick: '', gender: null, spId: 0, item: 0, abilityNum: null, level: 50, nature: 0,
      shiny: false, friendship: 70, ball: 0, evs: [0, 0, 0, 0, 0, 0], ivs: [31, 31, 31, 31, 31, 31], moves: [], warns: [] };
    if (/^[-–•]\s/.test(lines[0])) { warnings.push('bloque sin cabecera de especie, ignorado'); continue; }
    // cabecera: [Apodo ](Especie)[ (M|F)] @ Objeto
    const at = lines[0].split('@');
    let left = at[0].trim();
    if (at.length > 1) {
      const itemName = at.slice(1).join('@').trim();
      p.item = lookupFuzzy(L.items, itemName);
      if (!p.item) p.warns.push(`objeto no encontrado: «${itemName}»`);
    }
    const gm = left.match(/\((M|F|♂|♀)\)\s*$/i);
    if (gm) { p.gender = /m|♂/i.test(gm[1]) ? 0 : 1; left = left.slice(0, gm.index).trim(); }
    let spKey = left;
    const pm = left.match(/^(.+?)\(([^()]+)\)\s*$/);
    if (pm) { p.nick = pm[1].trim(); spKey = pm[2].trim(); }
    p.spId = findSpeciesKey(spKey);
    if (!p.spId) { warnings.push(`especie no encontrada: «${spKey}» — bloque ignorado`); continue; }
    const sp = QZ.species[p.spId - 1];
    for (const line of lines.slice(1)) {
      let m;
      if ((m = line.match(/^(?:ability|habilidad)\s*:\s*(.+)$/i))) {
        const abId = lookupFuzzy(L.abil, m[1]);
        const nums = [sp[9], sp[10], sp[11]];
        const idx = nums.indexOf(abId);
        if (abId == null || idx < 0) p.warns.push(`habilidad no encontrada para ${sp[0]}: «${m[1]}» (se usa la 1ª)`);
        else p.abilityNum = idx;
      } else if ((m = line.match(/^(?:level|nivel)\s*:\s*(\d+)$/i))) {
        p.level = Math.max(1, Math.min(100, Number(m[1])));
      } else if ((m = line.match(/^(.+?)\s+nature$/i)) || (m = line.match(/^naturaleza\s*:?\s*(.+)$/i))) {
        const nat = lookupFuzzy(L.nats, m[1]);
        if (nat == null) p.warns.push(`naturaleza no reconocida: «${m[1]}»`);
        else p.nature = nat;
      } else if ((m = line.match(/^(?:shiny|variocolor)\s*:\s*(.+)$/i))) {
        p.shiny = /^(yes|s[ií]|true|1)/i.test(m[1].trim());
      } else if ((m = line.match(/^(?:friendship|happiness|amistad)\s*:\s*(\d+)$/i))) {
        p.friendship = Math.max(0, Math.min(255, Number(m[1])));
      } else if ((m = line.match(/^evs\s*:\s*(.+)$/i))) {
        parseStatsLine(m[1], p.evs, p.warns);
      } else if ((m = line.match(/^ivs\s*:\s*(.+)$/i))) {
        parseStatsLine(m[1], p.ivs, p.warns);
      } else if ((m = line.match(/^[-–•]\s*(.+)$/))) {
        if (p.moves.length < 4) {
          const mv = lookupFuzzy(L.moves, m[1]);
          if (mv) p.moves.push(mv);
          else p.warns.push(`movimiento no encontrado: «${m[1]}»`);
        }
      } else if (/^tera(\s| type\s*:)/i.test(line) || /^tipo tera/i.test(line)) {
        if (!p.warns._tera) { p.warns.push('Tera no existe en el .sav de Quetzal: se ignora'); p.warns._tera = 1; }
      }
      // resto de líneas (OT, Género:, marcas…) se ignoran en silencio
    }
    mons.push(p);
  }
  return { mons, warnings };
}
function createRecordFromParsed(p) {
  const raw = newRecordBase();
  if (!raw) return null;
  const sp = QZ.species[p.spId - 1];
  const level = Math.max(1, Math.min(100, p.level || 50));
  // naturaleza + género (por defecto ♂, como en el modal) reescribiendo el byte bajo del PID
  const gb = sp ? sp[12] : 255;
  const femaleWant = p.gender === 1;
  let pidLow = p.nature || 0;
  if (gb !== 255 && gb !== 0 && gb !== 254) {
    for (let b = p.nature || 0; b < 256; b += 25) {
      if (qzIsFemale(b, gb) === femaleWant) { pidLow = b; break; }
    }
  }
  const ivs = p.ivs.map(x => Math.max(0, Math.min(31, x | 0)));
  const evs = p.evs.map(x => Math.max(0, Math.min(252, x | 0)));
  const base = sp ? [sp[3], sp[4], sp[5], sp[6], sp[7], sp[8]] : [50, 50, 50, 50, 50, 50];
  const hi = (Math.random() * 0x1000000) >>> 0;
  writeMonData(raw, {
    spId: p.spId, nick: (p.nick || spName(p.spId)).slice(0, 10),
    level, pid: (((hi << 8) >>> 0) | pidLow) >>> 0,
    shiny: p.shiny, abilityNum: p.abilityNum != null ? p.abilityNum : 0,
    item: p.item || 0, ball: p.ball || 0, friendship: p.friendship,
    ivs, evs, moves: [0, 1, 2, 3].map(k => p.moves[k] || 0),
    stats: qzCalcStats(base, level, ivs, evs, p.nature || 0),
  });
  return raw;
}
function importTeamTxt() {
  if (!S.save) { toast('Carga un archivo .sav primero'); return; }
  const text = $('txt-area').value;
  if (!text.trim()) { toast('Pega al menos un Pokémon en el cuadro de texto'); return; }
  const { mons, warnings } = parseTeamTxt(text);
  if (!mons.length) { renderTxtLog(warnings, []); toast('Ningún Pokémon reconocido en el texto', 3600); return; }
  const free = 6 - S.party.length;
  const added = [], perMon = [];
  for (const p of mons) {
    if (added.length >= free) break;
    const raw = createRecordFromParsed(p);
    if (raw) {
      S.party.push(raw);
      added.push(spName(p.spId));
      p.warns.forEach(w => perMon.push(`${spName(p.spId)}: ${w}`));
    }
  }
  const sinHueco = mons.length - added.length;
  S.dirty = true;
  renderParty();
  renderTrainer();
  renderTxtLog(warnings, perMon);
  closeTxtBox();
  let msg = `${added.length} Pokémon añadido${added.length === 1 ? '' : 's'} al equipo`;
  if (sinHueco > 0) msg += ` · ${sinHueco} sin hueco libre (solo entran ${free})`;
  toast(msg, 4200);
}
const EV_LABEL = ['HP', 'Ataque', 'Defensa', 'Vel', 'At. Esp.', 'Def. Esp.'];
function exportTeamTxt() {
  const out = [];
  for (const r of S.party) {
    const m = S.save.parsePartyRecord(r);
    if (!m.species) continue;
    const sp = QZ.species[m.species - 1];
    out.push(`${m.nickname || spName(m.species)}${m.item ? ` @ ${itName(m.item)}` : ''}`);
    const abId = [sp[9], sp[10], sp[11]][m.abilityNum] || sp[9];
    if (abId) out.push(`Habilidad: ${abName(abId)}`);
    out.push(`Nivel: ${m.level}`);
    out.push(`Naturaleza ${natName(m.nature)}`);
    const evTxt = m.evs.map((v, k) => (v ? `${v} ${EV_LABEL[k]}` : '')).filter(Boolean).join(' / ');
    if (evTxt) out.push(`EVs: ${evTxt}`);
    if (m.ivs.some(v => v !== 31)) {
      const ivTxt = m.ivs.map((v, k) => (v !== 31 ? `${v} ${EV_LABEL[k]}` : '')).filter(Boolean).join(' / ');
      if (ivTxt) out.push(`IVs: ${ivTxt}`);
    }
    if (m.friendship !== 70) out.push(`Amistad: ${m.friendship}`);
    if (m.shiny) out.push('Shiny: Sí');
    m.moves.forEach(mv => { if (mv) out.push(`- ${mvName(mv)}`); });
    out.push('');
  }
  $('txt-area').value = out.join('\n').replace(/\n+$/, '');
  $('txt-log').innerHTML = '';
}
function renderTxtLog(global, perMon) {
  const items = [...global, ...perMon];
  $('txt-log').innerHTML = items.length
    ? `<ul>${items.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>` : '';
}
function openTxtBox() {
  if (!S.save) { toast('Carga un archivo .sav primero'); return; }
  $('txt-free').textContent = String(6 - S.party.length);
  $('txt-log').innerHTML = '';
  $('txtbox').classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => $('txt-area').focus(), 30);
}
function closeTxtBox() {
  if (!$('txtbox').classList.contains('open')) return;
  $('txtbox').classList.remove('open');
  if (!$('modal').classList.contains('open') && !$('pick').classList.contains('open')) document.body.style.overflow = '';
}
$('btn-txt').addEventListener('click', openTxtBox);
$('txt-close').addEventListener('click', closeTxtBox);
$('txtbox').addEventListener('mousedown', (e) => { if (e.target === $('txtbox')) closeTxtBox(); });
$('txt-clear').addEventListener('click', () => { $('txt-area').value = ''; $('txt-log').innerHTML = ''; });
$('txt-import').addEventListener('click', importTeamTxt);
$('txt-export').addEventListener('click', exportTeamTxt);

/* ================= exportación ================= */
$('btn-export').addEventListener('click', exportSave);
$('btn-add').addEventListener('click', () => {
  if (S.party.length < 6) openModal(-1);
  else toast('El equipo ya está lleno (6/6)');
});

function exportSave() {
  if (!S.save) return;
  try {
    if (S.party.length > 6) throw new Error('el equipo no puede tener más de 6 Pokémon');
    const t = S.save.trainer();
    const buf = S.save.buildSectionData(1, (sec) => {
      // contador + registros; los slots restantes se ponen a cero (sin fantasmas)
      sec[QZS.SB1_PARTY_COUNT] = S.party.length;
      const area = QZS.SB1_PARTY + 6 * QZS.SLOT_BYTES;
      sec.fill(0, QZS.SB1_PARTY, Math.min(area, sec.length));
      S.party.forEach((rec, i) => sec.set(rec, QZS.SB1_PARTY + i * QZS.SLOT_BYTES));
      // dinero (XOR clave sección 0) y medallas (bit 7 de 0x14F + bits 0-6 de 0x150)
      wrU32(sec, QZS.SB1_MONEY, (S.money ^ t.moneyKey) >>> 0);
      let w = sec[0x14F] | (sec[0x150] << 8);
      for (let k = 0; k < 8; k++) {
        const p = 7 + k;
        if (S.badges[k]) w |= (1 << p); else w &= ~(1 << p) & 0xFFFF;
      }
      sec[0x14F] = w & 0xFF; sec[0x150] = (w >> 8) & 0xFF;
    });
    S.save.writeSection(1, buf);

    // PC: escribir secciones 5..15 con los cambios pendientes y sus checksums
    if (S.pcDirty && S.pcBuf) S.save.writePcBuffer(S.pcBuf);

    const checks = S.save.verifyChecksums();
    const ok = checks.every(c => c.ok);
    const blob = new Blob([S.save.downloadBlob()], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = S.fileName.replace(/\.sav$/i, '') + '_editado.sav';
    a.click();
    URL.revokeObjectURL(a.href);

    S.dirty = false;
    S.pcDirty = false;
    if (S.pcBuf) updatePcMeta();
    toast(ok ? `Exportado ${a.download} · ${checks.length}/${checks.length} checksums OK` : '¡Atención! Checksum inválido tras exportar', 3600);
  } catch (err) {
    toast('Error al exportar: ' + (err.message || String(err)), 4200);
  }
}

/* ================= arranque ================= */
navigateTo(routeFromHash());
