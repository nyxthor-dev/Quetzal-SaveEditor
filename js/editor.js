/* editor.js — UI del Quetzal Save Editor (SPA minimalista, fase pulido UX).
   Núcleo intacto: sav.js (checksum, secciones, party 104 B, PC bit-packed),
   data.js (tablas), learnsets.js (nivel + tutor NOVO MOV.) y names_es.js
   (nombres en español + rutas de sprites PokeAPI/pokesprite).

   Reglas del corpus (doc/06):
   - PC en SOLO LECTURA (formato ambiguo 38/31 B) → "Enviar a Caja" deshabilitado.
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
};
/* estado del modal de edición (sin tocar el save hasta Guardar) */
const M = { spId: 1, item: 0, moves: [0, 0, 0, 0], creating: false };

const $ = (id) => document.getElementById(id);
const SPRITE_BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/';
const PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="42" fill="#fff" stroke="#c9d2de" stroke-width="6"/><path d="M8 50a42 42 0 0 1 84 0z" fill="#e9edf3"/><line x1="8" y1="50" x2="92" y2="50" stroke="#c9d2de" stroke-width="6"/><circle cx="50" cy="50" r="13" fill="#fff" stroke="#c9d2de" stroke-width="6"/></svg>`);
const FALL_IDS = [1, 4, 7, 25, 133, 143, 150, 196, 248, 282, 289, 351, 381, 445, 448, 658, 727, 887, 906, 1017];

/* ================= helpers de datos ================= */
const spName = (id) => (QZ.species[id - 1] ? QZ.species[id - 1][0] : `Especie ${id}`);
const mvName = (id) => (QZ.movesES && QZ.movesES[id - 1]) || (QZ.moves[id - 1] ? QZ.moves[id - 1][0] : `Mov. ${id}`);
const mvNameEn = (id) => (QZ.moves[id - 1] ? QZ.moves[id - 1][0] : '');
const itName = (id) => (id === 0 ? '(ninguno)' : (QZ.itemsES && QZ.itemsES[id - 1]) || QZ.items[id - 1] || `Objeto ${id}`);
const itNameEn = (id) => (id === 0 ? '(ninguno)' : (QZ.items[id - 1] || itName(id)));
const abName = (id) => (QZ.abilities[id] || `Habilidad ${id}`);
const natName = (n) => (QZ.natures[n] ? QZ.natures[n][0] : `Nat ${n}`);
const ballName = (b) => (QZ.ballsES && QZ.ballsES[b]) || QZ.balls[b] || `Ball ${b}`;
const typeEs = { normal:'Normal', fighting:'Lucha', flying:'Volador', poison:'Veneno', ground:'Tierra', rock:'Roca', bug:'Bicho', ghost:'Fantasma', steel:'Acero', mystery:'???', fire:'Fuego', water:'Agua', grass:'Planta', electric:'Eléctrico', psychic:'Psíquico', ice:'Hielo', dragon:'Dragón', dark:'Siniestro', fairy:'Hada' };
const TYPE_COLOR = { normal:'#A8A878', fighting:'#C03028', flying:'#A890F0', poison:'#A040A0', ground:'#E0C068', rock:'#B8A038', bug:'#A8B820', ghost:'#705898', steel:'#B8B8D0', mystery:'#68A090', fire:'#F08030', water:'#6890F0', grass:'#78C850', electric:'#F8D030', psychic:'#F85888', ice:'#98D8D8', dragon:'#7038F8', dark:'#705848', fairy:'#EE99AC' };
const CAT_ES = { physical: 'Fís', special: 'Esp', status: 'Est' };
const STATN = ['HP', 'Ataque', 'Defensa', 'Velocidad', 'At. Esp.', 'Def. Esp.'];
const STAT_SHORT = ['HP', 'ATQ', 'DEF', 'VEL', 'ATQ ESP', 'DEF ESP'];
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const normQ = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const mon = (i) => S.save.parsePartyRecord(S.party[i]);

/* ---------- sprites (solo Pokémon; objetos y movimientos van SOLO con texto,
   el CDN de pokesprite resultó poco fiable y se descartó por decisión del usuario) ---------- */
function spriteUrl(speciesId, shiny) {
  if (!speciesId || speciesId > 1025) return null; // SP1026+ = especies propias de Quetzal sin sprite en PokeAPI
  return `${SPRITE_BASE}${shiny ? 'shiny/' : ''}${speciesId}.png`;
}
function spriteImg(speciesId, shiny, alt, cls) {
  const url = spriteUrl(speciesId, shiny);
  if (!url) return `<img class="${cls || ''}" src="${PLACEHOLDER}" alt="${escapeHtml(alt || '')}" title="Especie propia de Quetzal (sin sprite en PokeAPI)">`;
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

/* ================= tema ================= */
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $('btn-theme').textContent = t === 'dark' ? '☀️' : '🌙';
  localStorage.setItem('qz-theme', t);
}
applyTheme(localStorage.getItem('qz-theme') || 'light');
$('btn-theme').addEventListener('click', () =>
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

/* ================= fondo animado (Home) ================= */
let fallStarted = false;
function startFall() {
  if (fallStarted) return;
  fallStarted = true;
  const bg = $('fall-bg');
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const frag = document.createDocumentFragment();
  for (let k = 0; k < 16; k++) {
    const img = document.createElement('img');
    img.src = `${SPRITE_BASE}${FALL_IDS[k % FALL_IDS.length]}.png`;
    img.alt = '';
    img.loading = 'lazy';
    img.onerror = () => { img.style.visibility = 'hidden'; };
    const size = 38 + Math.random() * 54;
    img.style.left = (Math.random() * 96) + 'vw';
    img.style.width = img.style.height = size + 'px';
    img.style.opacity = (0.18 + Math.random() * 0.28).toFixed(2);
    img.style.animationDuration = (14 + Math.random() * 18) + 's';
    img.style.animationDelay = (-Math.random() * 30) + 's';
    frag.appendChild(img);
  }
  bg.appendChild(frag);
}

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
      homeStatus(`<span class="status-bad">✖ ${escapeHtml(err.message || String(err))}</span>`);
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
    <div class="status-line"><span class="status-ok">✔ ${escapeHtml(name)}</span>
      <span class="text-muted">· ${(bytes.length / 1024).toFixed(0)} KiB${bytes.length > 0x20000 ? ` (${bytes.length - 0x20000} B residuales ignorados)` : ''}</span></div>
    ${bad.length
      ? `<div class="status-line"><span class="status-bad">⚠ Checksums inválidos en secciones ${bad.join(', ')} — el juego puede ignorar este save; exporta bajo tu propio riesgo.</span></div>`
      : `<div class="status-line"><span class="status-ok">16/16 checksums verificados</span></div>`}`);

  $('home-shortcuts').classList.remove('d-none');
  $('btn-export').disabled = false;
  $('btn-add').disabled = false;
  renderTrainer();
  renderParty();
  renderPc();
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

  const cards = S.party.map((raw, i) => partyCardHtml(i)).join('');
  const addCard = S.party.length < 6
    ? `<button class="p-card add-card" id="btn-add-slot" title="Añadir Pokémon"><span class="plus">+</span><span>Añadir Pokémon</span></button>`
    : '';
  $('party-grid').innerHTML = cards + addCard;

  document.querySelectorAll('.p-card[data-i]').forEach(el =>
    el.addEventListener('click', () => openModal(Number(el.dataset.i))));
  const addBtn = $('btn-add-slot');
  if (addBtn) addBtn.addEventListener('click', () => openModal(-1));
}

function partyCardHtml(i) {
  const m = mon(i);
  if (!m.species) {
    return `<button class="p-card add-card" data-i="${i}"><span class="plus">+</span><span>Slot vacío — toca para añadir</span></button>`;
  }
  const sp = QZ.species[m.species - 1];
  return `
  <button class="p-card" data-i="${i}">
    <div class="sprite-wrap">${spriteImg(m.species, m.shiny, spName(m.species))}</div>
    <div class="meta">
      <div class="p-name">${m.shiny ? '<span class="shiny-mark">✦</span>' : ''}
        <span class="nm">${escapeHtml(m.nickname || spName(m.species))}</span>
        <span class="lvl">Nv. ${m.level}</span></div>
      <div class="type-row">${typeChips(sp)}</div>
      <div class="p-item-line">${m.item ? `<span class="item-name">${escapeHtml(itName(m.item))}</span>` : 'sin objeto'} · OT ${escapeHtml(m.ot)}</div>
    </div>
  </button>`;
}

/* ================= PC (solo lectura) ================= */
function renderPc() {
  const info = S.save.pcContents();
  S.pc = info;
  $('pc-badge').textContent = info.ambiguous ? 'Solo lectura · formato ambiguo' : `Solo lectura · ${info.format.size}B`;
  $('pc-badge').title = info.ambiguous
    ? `Candidatos: ${info.candidates.map(c => `${c.size}B×${c.boxes}`).join(' · ')} (doc/02 §7)`
    : '';
  const sel = $('pc-box-sel');
  sel.innerHTML = info.boxNames.map((n, i) => `<option value="${i}">${escapeHtml(n)}</option>`).join('');
  sel.onchange = renderPcBox;
  $('pc-meta').textContent = `${info.mons.length} Pokémon en el PC · caja actual del juego: ${info.boxNames[info.currentBox] ?? info.currentBox}`;
  renderPcBox();
}

function natNamePc(m) { return QZ.natures[m.nature] ? QZ.natures[m.nature][0] : m.nature; }

function renderPcBox() {
  const box = Number($('pc-box-sel').value || 0);
  const rows = S.pc.mons.filter(m => m.box === box);
  const byPos = Object.fromEntries(rows.map(m => [m.pos, m]));
  let html = '';
  for (let p = 0; p < 30; p++) {
    const m = byPos[p];
    if (!m) { html += `<div class="pc-slot" title="Vacío"></div>`; continue; }
    const natNamePcv = natNamePc(m);
    html += `<button class="pc-slot filled" data-p="${p}" title="${escapeHtml(m.nickname || spName(m.species))} · Nv.~${qzLevelForExp(m.exp)} · ${natNamePcv}">
      ${m.shiny ? '<span class="shiny-dot">✦</span>' : ''}${spriteImg(m.species, m.shiny, spName(m.species))}</button>`;
  }
  $('pc-grid').innerHTML = html;
  document.querySelectorAll('.pc-slot.filled').forEach(el => el.addEventListener('click', () => {
    const m = byPos[Number(el.dataset.p)];
    toast(`${escapeHtml(m.nickname || spName(m.species))} · exp ${m.exp} (≈Nv.${qzLevelForExp(m.exp)}) · ${natNamePc(m)} · IVs ${m.ivs.join('/')} · ${ballName(m.ball)}`, 4200);
  }));
}

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
const pick = { cfg: null, rows: [], active: 0 };

function openPicker(cfg) {
  pick.cfg = cfg;
  $('pick-title').textContent = cfg.title;
  $('pick-input').value = '';
  $('pick-foot').textContent = cfg.foot || '';
  $('pick-input').placeholder = cfg.placeholder || 'Buscar por nombre o número…';
  renderPick('');
  $('pick').classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => $('pick-input').focus(), 30);
}
function closePicker() {
  if (!$('pick').classList.contains('open')) return;
  $('pick').classList.remove('open');
  pick.cfg = null; pick.rows = [];
  if (!$('modal').classList.contains('open')) document.body.style.overflow = '';
  else document.body.style.overflow = 'hidden'; // el modal sigue abierto debajo
}
function pickRowHtml(r, idx) {
  return `<button class="pick-row${idx === pick.active ? ' active' : ''}" data-idx="${idx}" type="button">
    ${r.img ? `<span class="pick-img">${r.img}</span>` : '<span class="pick-img pick-img-empty"></span>'}
    <span class="pick-txt"><span class="pick-name">${r.title}</span>${r.sub ? `<span class="pick-sub">${r.sub}</span>` : ''}</span>
    ${r.badge ? `<span class="pick-badge">${r.badge}</span>` : ''}
    ${r.chip || ''}</button>`;
}
function renderPick(query) {
  const q = normQ(query).trim();
  const groups = pick.cfg.groups(q);
  pick.rows = []; pick.active = 0;
  let h = '';
  groups.forEach(g => {
    if (!g.rows.length) return;
    h += `<div class="pick-group">${g.label}</div>`;
    h += g.rows.map(r => { const idx = pick.rows.length; pick.rows.push(r); return pickRowHtml(r, idx); }).join('');
  });
  $('pick-body').innerHTML = h || '<div class="pick-empty">Sin resultados</div>';
  $('pick-body').scrollTop = 0;
  scrollPickActive();
}
function scrollPickActive() {
  const el = $('pick-body').querySelector('.pick-row.active');
  if (el) el.scrollIntoView({ block: 'nearest' });
}
function setActivePick(i) {
  if (!pick.rows.length) return;
  pick.active = Math.max(0, Math.min(pick.rows.length - 1, i));
  $('pick-body').querySelectorAll('.pick-row').forEach(el =>
    el.classList.toggle('active', Number(el.dataset.idx) === pick.active));
  scrollPickActive();
}
function confirmPick(i) {
  const r = pick.rows[i];
  if (!r) return;
  const cfg = pick.cfg;
  closePicker();
  cfg.onPick(r);
}
$('pick-input').addEventListener('input', (e) => renderPick(e.target.value));
$('pick-input').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); setActivePick(pick.active + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setActivePick(pick.active - 1); }
  else if (e.key === 'Enter') { e.preventDefault(); confirmPick(pick.active); }
  else if (e.key === 'Escape') { e.stopPropagation(); closePicker(); }
});
$('pick-body').addEventListener('click', (e) => {
  const row = e.target.closest('.pick-row');
  if (row) confirmPick(Number(row.dataset.idx));
});
$('pick-body').addEventListener('mousemove', (e) => {
  const row = e.target.closest('.pick-row');
  if (row && Number(row.dataset.idx) !== pick.active) setActivePick(Number(row.dataset.idx));
});
$('pick-close').addEventListener('click', closePicker);
$('pick').addEventListener('mousedown', (e) => { if (e.target === $('pick')) closePicker(); });

/* ---------- picker de especie ---------- */
function speciesRowHtml(id) {
  return spriteImg(id, false, spName(id), 'pick-sprite');
}
function openSpeciesPicker(current) {
  openPicker({
    title: 'Elegir especie',
    placeholder: 'Buscar especie por nombre o número de Dex…',
    foot: `${QZ.species.length} especies`,
    groups(q) {
      const all = QZ.species.map((s, k) => ({ id: k + 1, s }));
      let list;
      if (!q) {
        list = all;
      } else {
        list = all.filter(({ id, s }) =>
          normQ(s[0]).includes(q) || ( /^\d+$/.test(q) && (String(id) === q || String(id).padStart(4, '0').includes(q))));
      }
      // especies de Quetzal (SP1026+, sin sprite) al final si no hay búsqueda
      if (!q) list = list.slice().sort((a, b) => (a.id > 1025) - (b.id > 1025));
      return [{
        label: q ? `${list.length} resultados` : 'Todas las especies',
        rows: list.map(({ id, s }) => ({
          id,
          img: speciesRowHtml(id),
          title: `#${id} ${escapeHtml(s[0])}`,
          chip: `<span class="pick-chips">${typeChips(s)}</span>`,
        })),
      }];
    },
    onPick: (r) => setModalSpecies(r.id),
  });
  // marcar visualmente la actual: primer render, scroll hasta ella
  if (current) {
    const idx = pick.rows.findIndex(r => r.id === current);
    if (idx > 0) setActivePick(idx);
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
    const hit = normQ(mvName(mv)).includes(q) || normQ(mvNameEn(mv)).includes(q) ||
      ( /^\d+$/.test(q) && (String(mv) === q || String(mv).padStart(3, '0').includes(q)));
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
  if (idx > 0) setActivePick(idx);
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
        const hit = !q || normQ(itName(id)).includes(q) || normQ(itNameEn(id)).includes(q) ||
          ( /^\d+$/.test(q) && (String(id) === q || String(id).padStart(3, '0').includes(q)));
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
  if (idx > 0) setActivePick(idx);
}

/* ================= modal de edición ================= */
function fillSelect(sel, opts, value) {
  sel.innerHTML = opts.map(o => `<option value="${o.v}"${o.v === value ? ' selected' : ''}>${escapeHtml(o.t)}</option>`).join('');
}

function updateSpeciesBtn() {
  const sp = QZ.species[M.spId - 1];
  $('f-species-btn').innerHTML = `<span class="pick-btn-img">${spriteImg(M.spId, false, spName(M.spId))}</span>
    <span class="pick-btn-txt"><b>#${M.spId} ${escapeHtml(spName(M.spId))}</b>
    <span class="type-row">${typeChips(sp)}</span></span>`;
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
  $('m-delete').textContent = '🗑 Eliminar';
  $('m-delete').disabled = creating;
  $('m-box').disabled = true; // PC solo lectura (doc/02 §7)

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
  fillSelect($('f-nature'), QZ.natures.map((n, k) => ({ v: k, t: `${k} ${n[0]}` })), creating ? 0 : m.nature);
  fillAbility(spId, creating ? 0 : m.abilityNum);
  fillSelect($('f-ball'), QZ.balls.map((n, k) => ({ v: k, t: ballName(k) })), creating ? 3 : Math.min(m.ball, 25));
  $('f-friendship').value = creating ? 70 : m.friendship;
  $('f-shiny').checked = creating ? false : m.shiny;

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
function renderRadar(stats) {
  const svg = $('radar');
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

function recalcModal() {
  const st = modalState();
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

  let raw;
  if (M.creating) {
    raw = buildNewRecord(st);
    if (!raw) return;
    S.party[i] = raw; // slot vacío sobrescrito o posición nueva
  } else {
    raw = S.party[i];
  }
  // identidad
  wrU16(raw, 0x28, st.spId);
  const nick = $('f-nickname').value.trim() || spName(st.spId).slice(0, 10);
  raw.set(qzEncodeText(nick, 10), 0x08);
  const level = st.level;
  raw[0x58] = level;
  wrU32(raw, 0x2C, qzExpForLevel(level));
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
  // construir PID alto aleatorio solo en creación; en edición se conserva
  if (M.creating) {
    const hi = (Math.random() * 0x1000000) >>> 0;
    wrU32(raw, 0x00, (((hi << 8) >>> 0) | pidLow) >>> 0);
  } else {
    wrU32(raw, 0x00, ((mOld.pid & 0xFFFFFF00) | pidLow) >>> 0);
  }
  raw[0x13] = $('f-shiny').checked ? (raw[0x13] | 0x08) : (raw[0x13] & ~0x08 & 0xFF);
  // habilidad: preservar el resto de la palabra 0x54 (bit 30 constante)
  const abw = rdU32(raw, 0x54);
  wrU32(raw, 0x54, ((abw & ~(3 << 28)) | ((Number($('f-ability').value) & 3) << 28)) >>> 0);
  wrU16(raw, 0x2A, M.item || 0);
  raw[0x32] = Number($('f-ball').value) || 0;
  raw[0x31] = Math.max(0, Math.min(255, Number($('f-friendship').value) || 0));
  // IVs / EVs
  let ivw = (rdU32(raw, 0x50) & ~((1 << 30) - 1)) >>> 0;
  let nw = 0; st.ivs.forEach((x, j) => { nw |= (x & 31) << (5 * j); });
  wrU32(raw, 0x50, (ivw | nw) >>> 0);
  st.evs.forEach((x, k) => { raw[0x40 + k] = x; });
  // movimientos + PP base (los PP no se editan en la UI)
  M.moves.forEach((mv, k) => {
    wrU16(raw, 0x34 + 2 * k, mv);
    raw[0x3C + k] = mv ? QZ.moves[mv - 1][5] : 0;
  });
  // stats recalculados + HP actual = máximo
  st.stats.forEach((v, k) => wrU16(raw, 0x5A + 2 * k, Math.min(v, 65535)));
  wrU16(raw, 0x23, st.stats[0]);

  S.dirty = true;
  renderParty();
  closeModal();
  toast(M.creating ? `${spName(st.spId)} añadido al equipo` : 'Cambios aplicados (se guardan al exportar)');
});

/* crear un registro nuevo de 104 B (Añadir Pokémon) */
function buildNewRecord(st) {
  // clonar metadatos de OT (idioma, nombre OT, marcas...) de un miembro existente
  const donor = S.party.find(r => rdU16(r, 0x28));
  const raw = new Uint8Array(QZS.SLOT_BYTES);
  if (donor) {
    raw.set(donor.subarray(0x10, 0x28), 0x10); // idioma + OT name + zona no documentada
    wrU32(raw, 0x54, (rdU32(donor, 0x54) & (~((3 << 28) >>> 0))) >>> 0); // conservar bits altos desconocidos, habilidad a 0
  } else {
    toast('Para añadir necesitas al menos un Pokémon en el equipo (se clonan sus metadatos de OT)', 4200);
    return null;
  }
  wrU32(raw, 0x04, (S.save.trainer().tid | (S.save.trainer().sid << 16)) >>> 0); // OT ID del entrenador
  raw.set(qzEncodeText(spName(st.spId).slice(0, 10), 10), 0x08); // apodo provisional = nombre de especie
  // movimientos por defecto: últimos 4 del learnset por nivel ≤ nivel elegido
  // (defaultMoves añade los de «Evo.» solo si faltan) — el modal los preselecciona
  const moves = defaultMoves(st.spId, st.level);
  for (let k = 0; k < 4; k++) {
    const mv = moves[k] || 0;
    wrU16(raw, 0x34 + 2 * k, mv);
    raw[0x3C + k] = mv ? QZ.moves[mv - 1][5] : 0;
  }
  return raw;
}

/* eliminar (doble clic de confirmación) */
$('m-delete').addEventListener('click', () => {
  const i = S.editing;
  if (i < 0) return;
  if (S.deleting !== i) {
    S.deleting = i;
    $('m-delete').classList.add('armed');
    $('m-delete').textContent = '¿Seguro? Toca otra vez';
    setTimeout(() => { if (S.deleting === i) { S.deleting = -1; $('m-delete').classList.remove('armed'); $('m-delete').textContent = '🗑 Eliminar'; } }, 3000);
    return;
  }
  S.party.splice(i, 1);
  S.dirty = true;
  renderParty();
  closeModal();
  toast('Pokémon eliminado del equipo (se guarda al exportar)');
});

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

    const checks = S.save.verifyChecksums();
    const ok = checks.every(c => c.ok);
    const blob = new Blob([S.save.downloadBlob()], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = S.fileName.replace(/\.sav$/i, '') + '_editado.sav';
    a.click();
    URL.revokeObjectURL(a.href);

    S.dirty = false;
    toast(ok ? `Exportado ${a.download} · ${checks.length}/${checks.length} checksums OK` : '¡Atención! Checksum inválido tras exportar', 3600);
  } catch (err) {
    toast('Error al exportar: ' + (err.message || String(err)), 4200);
  }
}

/* ================= arranque ================= */
navigateTo(routeFromHash());
