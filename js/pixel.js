/* pixel.js — sprites pixelart 16×16 generados en el navegador (sin imágenes externas).
   Cada sprite se pinta en un <canvas> de 16×16 y se exporta como data URL;
   se muestra con `image-rendering: pixelated` a múltiplos enteros (32/48/64 px).

   Expone window.PX = { url(nombre), BALLS, POTIONS, MOON, SUN } */
(function () {
  'use strict';
  const N = 16;
  const OUTLINE = '#14213d';

  /* ---------- utilidades ---------- */
  // Espeja una mitad izquierda de 8 columnas para obtener el sprite completo de 16.
  const mirror = rows => rows.map(r => r + r.split('').reverse().join(''));

  // Convierte un mapa de caracteres + paleta en una rejilla de colores.
  function gridFrom(rows, pal) {
    return rows.map(r => r.split('').map(ch => (ch === '.' ? null : pal[ch] || null)));
  }

  // Añade contorno oscuro a los píxeles transparentes que tocan el sprite.
  function outline(g, color) {
    const out = g.map(r => r.slice());
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      if (g[y][x]) continue;
      const near = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
        const yy = y + dy, xx = x + dx;
        return yy >= 0 && yy < N && xx >= 0 && xx < N && g[yy][xx];
      });
      if (near) out[y][x] = color;
    }
    return out;
  }

  function toURL(g) {
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const ctx = c.getContext('2d');
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      if (!g[y][x]) continue;
      ctx.fillStyle = g[y][x];
      ctx.fillRect(x, y, 1, 1);
    }
    return c.toDataURL('image/png');
  }

  /* ---------- Pokéballs (procedurales) ---------- */
  function ball(opts) {
    const g = Array.from({ length: N }, () => Array(N).fill(null));
    const c = (N - 1) / 2;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const dx = x - c, dy = y - c, d = Math.hypot(dx, dy);
      if (d > 7.6) continue;
      let col;
      if (d > 6.3) col = OUTLINE;
      else if (Math.abs(dy) <= 1) col = OUTLINE;                       // banda central
      else if (dy < 0) col = (d > 5.1 && dx + dy > 2) ? opts.topShade : opts.top;
      else col = (d > 5.1 && dx + dy > 2) ? '#aab6c8' : '#f4f7fb';
      if (d < 2.95) col = OUTLINE;                                      // aro del botón
      if (d < 1.55) col = '#ffffff';                                    // botón
      g[y][x] = col;
    }
    // decoración propia de cada tipo
    (opts.marks || []).forEach(([x, y, col]) => { if (g[y][x] && g[y][x] !== OUTLINE) g[y][x] = col; });
    // brillo
    [[4, 3], [5, 3], [3, 4]].forEach(([x, y]) => { if (g[y][x] && g[y][x] !== OUTLINE) g[y][x] = opts.shine; });
    return g;
  }
  const sym = (cols, rows, col) => {            // marca simétrica respecto al eje vertical
    const m = [];
    cols.forEach(x => rows.forEach(y => { m.push([x, y, col]); m.push([N - 1 - x, y, col]); }));
    return m;
  };

  const BALLS = {
    great: ball({
      top: '#2f6fe0', topShade: '#1f4fb0', shine: '#8fb8ff',
      marks: sym([2, 3], [4, 5], '#e53b3b')
    }),
    ultra: ball({
      top: '#33343d', topShade: '#1d1e25', shine: '#7b7d8c',
      marks: sym([3, 4], [3, 4], '#f7c929').concat(sym([6], [2], '#f7c929'))
    }),
    master: ball({
      top: '#7d3fc9', topShade: '#5a2a96', shine: '#c9a2ff',
      marks: sym([2, 3], [4, 5], '#f06cc0').concat(sym([6], [3], '#f06cc0'))
    })
  };

  /* ---------- Pociones (mitad izquierda + espejo) ---------- */
  const POTION_ROWS = mirror([
    '........',
    '....kkkk',
    '...kgggg',
    '...kkkkk',
    '....kggg',
    '....kggg',
    '...kkLLL',
    '..kLLlLL',
    '..kLlLLL',
    '..kLLccd',
    '..kLLddd',
    '..kLLccd',
    '..kLLLLL',
    '..kLLLLL',
    '...kLLLL',
    '....kkkk'
  ]);
  const POTIONS = {
    potion:      gridFrom(POTION_ROWS, { k: OUTLINE, g: '#b9c2d0', L: '#a855d9', l: '#d8a6f5', c: '#fdf6e3', d: '#d9534f' }),
    superpotion: gridFrom(POTION_ROWS, { k: OUTLINE, g: '#e0453a', L: '#f08a24', l: '#ffc47a', c: '#fdf6e3', d: '#d9534f' })
  };

  /* ---------- Lunatone (luna) y Solrock (sol): iconos del botón de tema ----------
     PNG 24×24 con fondo transparente, reducidos a su rejilla de píxel original
     y guardados en assets/ (sin red). Se muestran al doble (48 px). */
  const THEME_ICONS = {
    moon: 'assets/lunatone.png',
    sun:  'assets/solrock.png'
  };

  /* ---------- registro + caché de data URLs ---------- */
  const SPRITES = {
    greatball: BALLS.great, ultraball: BALLS.ultra, masterball: BALLS.master,
    potion: POTIONS.potion, superpotion: POTIONS.superpotion
  };
  const cache = {};
  function url(name) {
    if (THEME_ICONS[name]) return THEME_ICONS[name];
    if (!cache[name]) cache[name] = toURL(outline(SPRITES[name], OUTLINE));
    return cache[name];
  }

  window.PX = {
    url,
    BALLS: ['greatball', 'ultraball', 'masterball'],
    POTIONS: ['potion', 'superpotion'],
    MOON: 'moon',
    SUN: 'sun'
  };
})();
