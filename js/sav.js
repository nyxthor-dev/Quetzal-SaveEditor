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
      let ok = 0, used = 0;
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
      }
      if (used && ok === used) candidates.push(fmt);
    }
    return { candidates, ambiguous: candidates.length !== 1, format: candidates[0] || null };
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

function qzSpeciesBase(speciesId) { // [hp,atk,def,spe,spa,spd] o null
  const sp = QZ.species[speciesId - 1];
  return sp ? [sp[3], sp[4], sp[5], sp[6], sp[7], sp[8]] : null;
}
