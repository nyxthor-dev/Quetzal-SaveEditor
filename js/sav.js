/* sav.js — núcleo de lectura/escritura del formato .sav de Pokémon Quetzal (Alpha 9).
   Puerto JS de tools/quetzal_save.py (autopsia). Ver doc/00_mapa_rapido.md y datos/offsets.json.

   REGLAS DE SEGURIDAD (doc/03):
   - Identificar secciones por ID (0xFF4), NUNCA por posición física.
   - Tras editar una sección, recalcular SIEMPRE su checksum (0xFF6).
   - Escribir siempre a un archivo nuevo; jamás sobrescribir el original. */

const QZS = {
  SECTOR: 0x1000,          // 4096
  SIGNATURE: 0x08012025,
  SECTORS_PER_SLOT: 16,    // Quetzal amplió Gen 3 (14) a 16
  DATA_SIZE: 0xFF4,        // bytes cubiertos por el checksum
  PC_CHUNK: 0xF80,         // bytes útiles del PC por sección
  SB1_SECTIONS: [1, 2, 3, 4],
  PC_SECTIONS: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  PC_RECORDS_OFFSET: 0x461,
  BOX_SLOTS: 30,
  SLOT_BYTES: 104,
  SB1_PARTY_COUNT: 0x6A4,
  SB1_PARTY: 0x6A8,
  SB1_MONEY: 0x918,
  SB1_COINS: 0x91C,        // PROBABLE
  SB1_BADGES: 0x14F,       // bit 7 de 0x14F + bits 0-6 de 0x150
  PC_FORMATS: [            // (bytes por registro, cajas)
    { size: 38, boxes: 37 },   // ES/PT-BR: apodo@28, PP@24, HP@bits168
    { size: 31, boxes: 45 },   // EN: bits 0-167 + apodo@21
    { size: 21, boxes: 67 },   // EN: solo bits 0-167
  ],
};

/* ---------- checksum de sección (validado 32/32) ---------- */
function qzChecksum(data) { // data: Uint8Array de >= 0xFF4 bytes
  let s = 0;
  for (let i = 0; i + 3 < QZS.DATA_SIZE; i += 4) {
    s = (s + data[i] + (data[i + 1] << 8) + (data[i + 2] << 16) + data[i + 3] * 0x1000000) >>> 0;
  }
  return (((s & 0xFFFF) + (s >>> 16)) & 0xFFFF) >>> 0;
}

/* ---------- charmap Gen 3 occidental ---------- */
const QZ_CHARMAP_DEC = { 0x00: ' ' };
for (let i = 0; i < 26; i++) {
  QZ_CHARMAP_DEC[0xBB + i] = String.fromCharCode(65 + i);   // A-Z
  QZ_CHARMAP_DEC[0xD5 + i] = String.fromCharCode(97 + i);   // a-z
}
for (let i = 0; i < 10; i++) QZ_CHARMAP_DEC[0xA2 + i] = String.fromCharCode(48 + i);
Object.assign(QZ_CHARMAP_DEC, { 0xB8: '♂', 0xB9: '♀', 0xAD: '-', 0xAC: '.', 0xAB: '?', 0xA1: '!' });

function qzDecodeText(bytes, start, len) {
  let out = '';
  for (let i = 0; i < len; i++) {
    const c = bytes[start + i];
    if (c === 0xFF) break;
    out += QZ_CHARMAP_DEC[c] ?? '?';
  }
  return out.trim();
}

const QZ_CHARMAP_ENC = { ' ': 0x00, '♂': 0xB8, '♀': 0xB9, '-': 0xAD, '.': 0xAC, '?': 0xAB, '!': 0xA1,
  'á': 0x17, 'í': 0x1B, 'ó': 0x23 }; // acentos observados en esta traducción (doc/01); resto → '?'
for (let i = 0; i < 26; i++) {
  QZ_CHARMAP_ENC[String.fromCharCode(65 + i)] = 0xBB + i;
  QZ_CHARMAP_ENC[String.fromCharCode(97 + i)] = 0xD5 + i;
}
for (let i = 0; i < 10; i++) QZ_CHARMAP_ENC[String.fromCharCode(48 + i)] = 0xA2 + i;

function qzEncodeText(str, len) {
  const out = new Uint8Array(len).fill(0xFF);
  for (let i = 0; i < Math.min(str.length, len); i++) {
    out[i] = QZ_CHARMAP_ENC[str[i]] ?? 0xAB;
  }
  return out;
}

/* ---------- bits LSB-first (registros PC empaquetados) ---------- */
function qzGetBits(buf, start, width) {
  let r = 0;
  for (let b = 0; b < width; b++) {
    const p = start + b;
    r += ((buf[p >> 3] >> (p & 7)) & 1) << b;
  }
  return r >>> 0;
}
function qzSetBits(buf, start, width, val) {
  for (let b = 0; b < width; b++) {
    const p = start + b;
    if ((val >>> b) & 1) buf[p >> 3] |= (1 << (p & 7));
    else buf[p >> 3] &= ~(1 << (p & 7)) & 0xFF;
  }
}

/* ---------- u16/u32 helpers (little-endian) ---------- */
function rdU16(b, o) { return b[o] | (b[o + 1] << 8); }
function rdU32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | b[o + 3] * 0x1000000) >>> 0; }
function wrU16(b, o, v) { b[o] = v & 0xFF; b[o + 1] = (v >>> 8) & 0xFF; }
function wrU32(b, o, v) { v = v >>> 0; b[o] = v & 0xFF; b[o + 1] = (v >>> 8) & 0xFF; b[o + 2] = (v >>> 16) & 0xFF; b[o + 3] = (v >>> 24) & 0xFF; }

/* ---------- carga y mapeo del save ---------- */
class QuetzalSave {
  constructor(bytes) { // bytes: Uint8Array de >= 0x20000
    if (bytes.length < 0x20000) throw new Error(`archivo demasiado pequeño: ${bytes.length} B (se esperan >= 128 KiB)`);
    this.raw = bytes.slice(0, 0x20000);          // solo la flash mapeada
    this._map();
  }

  _sectorInfo(phys) {
    const o = phys * QZS.SECTOR;
    return {
      id: rdU16(this.raw, o + 0xFF4),
      chk: rdU16(this.raw, o + 0xFF6),
      sig: rdU32(this.raw, o + 0xFF8),
      index: rdU32(this.raw, o + 0xFFC),
    };
  }

  _readSlot(start) {
    const infos = [];
    for (let k = 0; k < QZS.SECTORS_PER_SLOT; k++) infos.push(this._sectorInfo(start + k));
    if (infos.some(i => i.sig !== QZS.SIGNATURE)) return null;
    const ids = infos.map(i => i.id).sort((a, b) => a - b);
    for (let i = 0; i < 16; i++) if (ids[i] !== i) return null;
    if (new Set(infos.map(i => i.index)).size !== 1) return null;
    const map = {};
    infos.forEach((inf, k) => { map[inf.id] = start + k; });
    return { start, index: infos[0].index, map };
  }

  _map() {
    const a = this._readSlot(0), b = this._readSlot(QZS.SECTORS_PER_SLOT);
    const valid = [a, b].filter(Boolean);
    if (!valid.length) throw new Error('ningún slot con las 16 secciones y firma 0x08012025 válidas (¿es un .sav de Quetzal?)');
    const act = valid.reduce((m, s) => (s.index > m.index ? s : m));
    this.activeSlot = act.start;        // offset físico de la primera sección del slot (0x0000 o 0x10000)
    this.slotIndex = act.index;
    this.slotMap = act.map;             // id de sección -> offset físico (en sectores)
    this.otherSlotMap = null;
    const other = valid.find(s => s !== act);
    if (other) this.otherSlotMap = other.map;
  }

  sectionOffset(sid) { return this.slotMap[sid] * QZS.SECTOR; }

  sectionData(sid) { // copia de los primeros 0xF80 bytes de datos de la sección
    return this.raw.slice(this.sectionOffset(sid), this.sectionOffset(sid) + QZS.PC_CHUNK);
  }

  verifyChecksums() {
    const res = [];
    for (const sid of Object.keys(this.slotMap).map(Number).sort((a, b) => a - b)) {
      const o = this.sectionOffset(sid);
      const calc = qzChecksum(this.raw.subarray(o, o + QZS.DATA_SIZE));
      const stored = rdU16(this.raw, o + 0xFF6);
      res.push({ sid, ok: calc === stored, calc, stored });
    }
    return res;
  }

  /* ---------- entrenador (sección 0) ---------- */
  trainer() {
    const s0 = this.sectionData(0);
    return {
      name: qzDecodeText(s0, 0x00, 8),
      characterByte: s0[0x08],
      tid: rdU16(s0, 0x0A),
      sid: rdU16(s0, 0x0C),
      hours: rdU16(s0, 0x10), minutes: s0[0x14], seconds: s0[0x15],
      moneyKey: rdU32(s0, 0x2C),
    };
  }

  saveBlock1() { // 15.872 bytes = secciones 1-4 × 0xF80
    const parts = QZS.SB1_SECTIONS.map(sid => this.sectionData(sid));
    const out = new Uint8Array(QZS.PC_CHUNK * 4);
    parts.forEach((p, i) => out.set(p, i * QZS.PC_CHUNK));
    return out;
  }

  money() { return (rdU32(this.saveBlock1(), QZS.SB1_MONEY) ^ this.trainer().moneyKey) >>> 0; }
  badges() { // 8 bits desde el bit 7 de 0x14F
    const sb1 = this.saveBlock1();
    const w = sb1[0x14F] | (sb1[0x150] << 8);
    const out = [];
    for (let k = 0; k < 8; k++) out.push((w >>> (7 + k)) & 1);
    return out;
  }

  /* ---------- party: registros planos de 104 bytes ---------- */
  partyCount() { return this.saveBlock1()[QZS.SB1_PARTY_COUNT]; }

  partyRecord(i) { // 0..5 → copia de los 104 bytes
    const sb1 = this.saveBlock1();
    const o = QZS.SB1_PARTY + i * QZS.SLOT_BYTES;
    return sb1.slice(o, o + QZS.SLOT_BYTES);
  }

  parsePartyRecord(raw) { // raw: Uint8Array(104) — ver doc/04
    const ivw = rdU32(raw, 0x50), abw = rdU32(raw, 0x54);
    return {
      pid: rdU32(raw, 0x00),
      otId: rdU32(raw, 0x04),
      nickname: qzDecodeText(raw, 0x08, 10),
      shiny: !!(raw[0x13] & 0x08),
      ot: qzDecodeText(raw, 0x14, 7),
      hpCur: rdU16(raw, 0x23),
      species: rdU16(raw, 0x28),
      item: rdU16(raw, 0x2A),
      exp: rdU32(raw, 0x2C),
      friendship: raw[0x31],
      ball: raw[0x32],
      moves: [rdU16(raw, 0x34), rdU16(raw, 0x36), rdU16(raw, 0x38), rdU16(raw, 0x3A)],
      pp: [raw[0x3C], raw[0x3D], raw[0x3E], raw[0x3F]],
      evs: [raw[0x40], raw[0x41], raw[0x42], raw[0x43], raw[0x44], raw[0x45]],
      ivs: [0, 1, 2, 3, 4, 5].map(k => (ivw >>> (5 * k)) & 31),
      abilityNum: (abw >>> 28) & 3,
      level: raw[0x58],
      stats: [0, 1, 2, 3, 4, 5].map(k => rdU16(raw, 0x5A + 2 * k)),
      nature: qzNatureOfPid(rdU32(raw, 0x00)),
    };
  }

  /* ---------- PC ---------- */
  pcBuffer() {
    const out = new Uint8Array(QZS.PC_CHUNK * 11);
    QZS.PC_SECTIONS.forEach((sid, i) => out.set(this.sectionData(sid), i * QZS.PC_CHUNK));
    return out;
  }

  detectPcFormat() { // devuelve {format, ambiguous, candidates}
    const pc = this.pcBuffer();
    const candidates = [];
    for (const fmt of QZS.PC_FORMATS) {
      let ok = 0, used = 0, score = 0;
      for (let s = 0; s < fmt.boxes * QZS.BOX_SLOTS; s++) {
        const off = QZS.PC_RECORDS_OFFSET + s * fmt.size;
        let empty = true;
        for (let b = 0; b < fmt.size; b++) if (pc[off + b]) { empty = false; break; }
        if (empty) continue;
        used++;
        const sp = qzGetBits(pc, off * 8, 11);
        const nat = qzGetBits(pc, off * 8 + 161, 5);
        const ab = qzGetBits(pc, off * 8 + 166, 2);
        let mvOk = true;
        for (let m = 0; m < 4; m++) if (qzGetBits(pc, off * 8 + 48 + m * 10, 10) > 848) mvOk = false;
        if (sp >= 1 && sp <= 1528 && nat <= 24 && ab <= 2 && mvOk) ok++;
        // desempate: en el formato de 38 B el campo apodo (bytes 28..37) debe
        // decodificar como texto charmap válido terminado en 0xFF y los PP
        // (bytes 24..27) ser valores pequeños. Bajo un formato más corto, esa
        // misma zona son datos basura y casi nunca pasa el filtro.
        score += qzNickScore(pc, off, fmt.size);
      }
      if (used && ok === used) candidates.push({ fmt, score });
    }
    if (!candidates.length) return { candidates: [], ambiguous: true, format: null };
    candidates.sort((a, b) => b.score - a.score);
    // ambiguo solo si el 2º candidato empatan por puntuación (mismo peso de evidencia)
    const ambiguous = candidates.length > 1 && candidates[1].score === candidates[0].score;
    return { candidates: candidates.map(c => c.fmt), ambiguous, format: candidates[0].fmt };
  }

  parsePcRecord(pc, off, size, box, pos) {
    const rec = pc.subarray(off, off + size);
    return {
      box, pos,
      species: qzGetBits(rec, 0, 11),
      item: qzGetBits(rec, 11, 10),
      exp: qzGetBits(rec, 21, 17) * 10,
      ball: qzGetBits(rec, 38, 6),
      shiny: !!qzGetBits(rec, 44, 1),
      moves: [0, 1, 2, 3].map(m => qzGetBits(rec, 48 + m * 10, 10)),
      evs: [0, 1, 2, 3, 4, 5].map(e => qzGetBits(rec, 88 + e * 6, 6) * 4),
      ivs: [0, 1, 2, 3, 4, 5].map(i => qzGetBits(rec, 124 + i * 5, 5)),
      female: !!qzGetBits(rec, 160, 1),
      nature: qzGetBits(rec, 161, 5),
      abilityNum: qzGetBits(rec, 166, 2),
      flags: qzGetBits(rec, 154, 6), // bits aún no documentados entre IVs y género: se conservan al reescribir
      hpCur: size === 38 ? qzGetBits(rec, 168, 16) : null,
      pp: size === 38 ? [rec[24], rec[25], rec[26], rec[27]] : null,
      nickname: size === 38 ? qzDecodeText(rec, 28, 10) : (size === 31 ? qzDecodeText(rec, 21, 10) : ''),
      size,
    };
  }

  pcContents() { // {currentBox, boxNames, format, ambiguous, mons}
    const pc = this.pcBuffer();
    const det = this.detectPcFormat();
    const fmt = det.format || QZS.PC_FORMATS[0]; // si es ambiguo, solo-lectura con supuesto
    const boxNames = [];
    for (let b = 0; b < fmt.boxes; b++) boxNames.push(qzDecodeText(pc, 1 + b * 9, 9) || `Caja ${b + 1}`);
    const mons = [];
    for (let s = 0; s < fmt.boxes * QZS.BOX_SLOTS; s++) {
      const off = QZS.PC_RECORDS_OFFSET + s * fmt.size;
      let empty = true;
      for (let b = 0; b < fmt.size; b++) if (pc[off + b]) { empty = false; break; }
      if (empty) continue;
      const box = Math.floor(s / QZS.BOX_SLOTS), pos = s % QZS.BOX_SLOTS;
      mons.push(this.parsePcRecord(pc, off, fmt.size, box, pos));
    }
    return { currentBox: pc[0], boxNames, format: fmt, ambiguous: det.ambiguous, candidates: det.candidates, mons };
  }

  /* ---------- escritura (fase 2, con recalculo de checksum) ---------- */
  writeSection(sid, data0xFF4) { // sobrescribe los 0xFF4 primeros bytes del slot ACTIVO y recalcula checksum
    if (data0xFF4.length !== QZS.DATA_SIZE) throw new Error('se deben escribir exactamente 0xFF4 bytes');
    const o = this.sectionOffset(sid);
    this.raw.set(data0xFF4, o);
    wrU16(this.raw, o + 0xFF6, qzChecksum(this.raw.subarray(o, o + QZS.DATA_SIZE)));
  }

  buildSectionData(sid, mutate) { // extrae 0xFF4 bytes, permite mutarlos y los devuelve
    const o = this.sectionOffset(sid);
    const buf = this.raw.slice(o, o + QZS.DATA_SIZE); // copia
    if (mutate) mutate(buf);
    return buf;
  }

  writePcBuffer(pc) { // pc: Uint8Array(PC_CHUNK*11) mutado → recompone secciones 5..15 y sus checksums
    if (pc.length !== QZS.PC_CHUNK * QZS.PC_SECTIONS.length) throw new Error('buffer PC de tamaño inesperado');
    QZS.PC_SECTIONS.forEach((sid, i) => {
      // se conservan los bytes 0xF80..0xFF3 originales de cada sección (cuentan para el checksum)
      const buf = this.buildSectionData(sid);
      buf.set(pc.subarray(i * QZS.PC_CHUNK, (i + 1) * QZS.PC_CHUNK), 0);
      this.writeSection(sid, buf);
    });
  }

  downloadBlob() { // Uint8Array completo (incluye los 16 B residuales si el original los tenía)
    return this.raw;
  }
}

/* ---------- reglas derivadas (doc/04-05) ---------- */
function qzNatureOfPid(pid) { return (pid % 256) % 25; }

function qzExpForLevel(l) { return Math.floor(6 * l * l * l / 5) - 15 * l * l + 100 * l - 140; }
function qzLevelForExp(exp) {
  let l = 1;
  while (l < 100 && qzExpForLevel(l + 1) <= exp) l++;
  return l;
}

// fórmula Gen 3+ (statsBase de especies.csv en orden HP/Atk/Def/Spe/SpA/SpD)
function qzCalcStats(base, level, ivs, evs, nature) {
  const out = [];
  for (let s = 0; s < 6; s++) {
    const evc = Math.floor((evs[s] || 0) / 4);
    if (s === 0) {
      out.push(Math.floor((2 * base[0] + ivs[0] + evc) * level / 100) + level + 10);
    } else {
      let v = Math.floor((2 * base[s] + ivs[s] + evc) * level / 100) + 5;
      const nat = QZ.natures[nature];
      if (nat[1] === s) v = Math.floor(v * 1.1);
      else if (nat[2] === s) v = Math.floor(v * 0.9);
      out.push(v);
    }
  }
  return out;
}

function qzIsFemale(pidLow, genderByte) {
  if (genderByte === 255 || genderByte === 0 || genderByte === 254) return null; // sin género / solo macho / solo hembra
  return pidLow < genderByte;
}

/* puntuación de plausibilidad del apodo (38B: bytes 28..37; 31B: 21..30).
   1 si hay ≥3 letras/dígitos charmap válidos seguidos de 0xFF dentro del campo. */
function qzNickScore(pc, off, size) {
  const nickOff = size === 38 ? 28 : size === 31 ? 21 : -1;
  if (nickOff < 0) return 0;
  let letters = 0;
  for (let i = 0; i < 10; i++) {
    const c = pc[off + nickOff + i];
    if (c === 0xFF) return letters >= 3 ? 1 : 0;
    const valid = (c >= 0xBB && c <= 0xEE) || (c >= 0xA1 && c <= 0xB9) || c === 0x00;
    if (!valid) return 0;
    if (c !== 0x00) letters++;
  }
  return 0; // sin terminador: sospechoso
}

function qzSpeciesBase(speciesId) { // [hp,atk,def,spe,spa,spd] o null
  const sp = QZ.species[speciesId - 1];
  return sp ? [sp[3], sp[4], sp[5], sp[6], sp[7], sp[8]] : null;
}

/* ---------- codificación de registros PC (espejo de parsePcRecord) ----------
   o = { species, item, exp, ball, shiny, moves[4], evs[6], ivs[6], female,
         nature, abilityNum, hpCur, pp[4], nickname } · size = 38|31|21 bytes.
   Layout de bits (LSB-first, validado contra doc/02 y detección de formato):
   especie@0(11) objeto@11(10) exp/10@21(17) ball@38(6) shiny@44 movs@48(4×10)
   EVs/4@88(6×6) IVs@124(5×6) hembra@160 naturaleza@161(5) habilidad@166(2)
   38B: HP@168(16) + PP en bytes 24-27 + apodo@28(10) · 31B: apodo@21(10) */
function qzEncodePcRecord(o, size) {
  const rec = new Uint8Array(size);
  qzSetBits(rec, 0, 11, o.species & 0x7FF);
  qzSetBits(rec, 11, 10, (o.item || 0) & 0x3FF);
  qzSetBits(rec, 21, 17, Math.min(0x1FFFF, Math.floor((o.exp || 0) / 10)));
  qzSetBits(rec, 38, 6, (o.ball || 0) & 0x3F);
  qzSetBits(rec, 44, 1, o.shiny ? 1 : 0);
  [0, 1, 2, 3].forEach(m => qzSetBits(rec, 48 + m * 10, 10, (o.moves[m] || 0) & 0x3FF));
  o.evs.forEach((v, e) => qzSetBits(rec, 88 + e * 6, 6, Math.min(63, Math.floor((v || 0) / 4))));
  o.ivs.forEach((v, i) => qzSetBits(rec, 124 + i * 5, 5, (v || 0) & 31));
  qzSetBits(rec, 154, 6, (o.flags || 0) & 63); // bits no documentados: conservar el valor original
  qzSetBits(rec, 160, 1, o.female ? 1 : 0);
  qzSetBits(rec, 161, 5, (o.nature || 0) & 31);
  qzSetBits(rec, 166, 2, (o.abilityNum || 0) & 3);
  if (size === 38) {
    qzSetBits(rec, 168, 16, Math.min(65535, o.hpCur || 0));
    [0, 1, 2, 3].forEach(k => { rec[24 + k] = (o.pp && o.pp[k]) || 0; });
    rec.set(qzEncodeText((o.nickname || '').slice(0, 10), 10), 28);
  } else if (size === 31) {
    rec.set(qzEncodeText((o.nickname || '').slice(0, 10), 10), 21);
  }
  return rec;
}
