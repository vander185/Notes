/* ==========================================================================
   Scanner de documents (façon Adobe Scan)
   - caméra arrière en direct, détection automatique des bords, déclenchement auto
   - recadrage avec 4 coins + loupe, redressement de la perspective
   - filtres : couleur améliorée, noir & blanc, gris, original
   - plusieurs pages, rotation, ordre, suppression
   - enregistré chiffré dans le coffre en PDF (ou en photos)
   Tout se fait sur le téléphone : aucune image ne quitte l'appareil.
   ========================================================================== */
(() => {
'use strict';

/* ---------- Algorithmes (purs, testables) ---------- */
const SC = window.SCANCORE = {};

// niveaux de gris flous d'une image réduite
SC.gray = (d, w, h) => {
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = d[j] * .299 + d[j + 1] * .587 + d[j + 2] * .114;
  return g;
};
SC.blur = (g, w, h, r = 2) => {   // flou boîte séparable
  const t = new Float32Array(g.length), o = new Float32Array(g.length), n = 2 * r + 1;
  for (let y = 0; y < h; y++) { let s = 0; const row = y * w;
    for (let x = -r; x <= r; x++) s += g[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) { t[row + x] = s / n; s += g[row + Math.min(w - 1, x + r + 1)] - g[row + Math.max(0, x - r)]; } }
  for (let x = 0; x < w; x++) { let s = 0;
    for (let y = -r; y <= r; y++) s += t[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) { o[y * w + x] = s / n; s += t[Math.min(h - 1, y + r + 1) * w + x] - t[Math.max(0, y - r) * w + x]; } }
  return o;
};
SC.otsu = g => {
  const hist = new Float64Array(256); for (const v of g) hist[Math.min(255, v | 0)]++;
  const N = g.length; let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sB = 0, wB = 0, best = 0, t = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue; const wF = N - wB; if (!wF) break;
    sB += i * hist[i]; const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; t = i; }
  }
  return { t, sep: Math.sqrt(best) / N };   // sep : écart entre fond et document
};
const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
SC.hull = P => {   // enveloppe convexe (chaîne monotone)
  P = P.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (P.length < 3) return P;
  const lo = [], up = [];
  for (const p of P) { while (lo.length > 1 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (up.length > 1 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
};
SC.area = q => { let s = 0; for (let i = 0; i < q.length; i++) { const a = q[i], b = q[(i + 1) % q.length]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s) / 2; };
SC.order = q => {   // haut-gauche, haut-droit, bas-droit, bas-gauche
  const s = q.map(p => p[0] + p[1]), d = q.map(p => p[0] - p[1]);
  const tl = q[s.indexOf(Math.min(...s))], br = q[s.indexOf(Math.max(...s))], tr = q[d.indexOf(Math.max(...d))], bl = q[d.indexOf(Math.min(...d))];
  const o = [tl, tr, br, bl];
  return new Set(o).size === 4 ? o.map(p => [p[0], p[1]]) : null;
};
SC.convex = q => { let sg = 0; for (let i = 0; i < 4; i++) { const c = cross(q[i], q[(i + 1) % 4], q[(i + 2) % 4]); if (!c) return false; if (!sg) sg = Math.sign(c); else if (Math.sign(c) !== sg) return false; } return true; };

// Détection du document dans une image RGBA réduite → 4 coins (en pixels de cette image) ou null
SC.detect = (d, w, h) => {
  const g = SC.blur(SC.gray(d, w, h), w, h, 2);
  const { t, sep } = SC.otsu(g);
  if (sep < 0.045 * 255 / 2) return null;   // pas assez de contraste entre feuille et fond
  // masque clair (feuille) puis ouverture pour casser les petits ponts avec le fond
  let m = new Uint8Array(w * h); for (let i = 0; i < m.length; i++) m[i] = g[i] > t ? 1 : 0;
  const morph = (src, keep) => { const o = new Uint8Array(src.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = keep;
      for (let dy = -1; dy <= 1 && v === keep; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = y + dy, xx = x + dx; if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue; if (src[yy * w + xx] !== keep) { v = 1 - keep; break; } }
      o[y * w + x] = v; } return o; };
  m = morph(morph(m, 1), 0);
  // plus grande zone claire
  const lab = new Int32Array(w * h), st = new Int32Array(w * h); let best = 0, bestN = 0, cur = 0;
  for (let i = 0; i < m.length; i++) {
    if (!m[i] || lab[i]) continue; cur++; let sp = 0, n = 0; st[sp++] = i; lab[i] = cur;
    while (sp) { const p = st[--sp]; n++; const x = p % w, y = (p / w) | 0;
      if (x > 0 && m[p - 1] && !lab[p - 1]) { lab[p - 1] = cur; st[sp++] = p - 1; }
      if (x < w - 1 && m[p + 1] && !lab[p + 1]) { lab[p + 1] = cur; st[sp++] = p + 1; }
      if (y > 0 && m[p - w] && !lab[p - w]) { lab[p - w] = cur; st[sp++] = p - w; }
      if (y < h - 1 && m[p + w] && !lab[p + w]) { lab[p + w] = cur; st[sp++] = p + w; } }
    if (n > bestN) { bestN = n; best = cur; }
  }
  const ratio = bestN / (w * h);
  if (!best || ratio < 0.08 || ratio > 0.96) return null;
  // bords gauche/droit de chaque ligne → enveloppe convexe
  const pts = []; let touch = 0, tT = 0, tB = 0, tL = 0, tR = 0;
  for (let y = 0; y < h; y++) { let a = -1, b = -1; const r = y * w;
    for (let x = 0; x < w; x++) if (lab[r + x] === best) { if (a < 0) a = x; b = x; }
    if (a >= 0) { pts.push([a, y], [b + 1, y]); if (a === 0) tL++; if (b === w - 1) tR++; if (y === 0) tT++; if (y === h - 1) tB++; } }
  touch = (tL > h * .5) + (tR > h * .5) + (tT > 0 && tB > 0 ? 1 : 0);
  if (touch >= 3) return null;   // c'est le fond, pas une feuille
  const H = SC.hull(pts); if (H.length < 4) return null;
  // quadrilatère d'aire maximale inscrit dans l'enveloppe (amélioration itérative)
  let q = SC.order(H); if (!q) return null;
  let idx = q.map(p => H.findIndex(h2 => h2[0] === p[0] && h2[1] === p[1]));
  for (let it = 0; it < 3; it++) for (let k = 0; k < 4; k++) {
    let bi = idx[k], ba = -1;
    for (let j = 0; j < H.length; j++) { const tq = idx.map((v, z) => H[z === k ? j : v]); const a = SC.area(tq); if (a > ba && SC.convex(tq)) { ba = a; bi = j; } }
    idx[k] = bi;
  }
  q = SC.order(idx.map(i => H[i])); if (!q || !SC.convex(q)) return null;
  if (SC.area(q) < SC.area(H) * .82) return null;   // forme trop éloignée d'une feuille
  return q;
};

/* ---------- Détection v2 : plusieurs méthodes, notées sur les vrais bords, puis affinées ---------- */
SC.sobel = (g, w, h) => {
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h), m = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, a = g[i - w - 1], b = g[i - w], c = g[i - w + 1], d = g[i - 1], f = g[i + 1], k = g[i + w - 1], l = g[i + w], n = g[i + w + 1];
    const X = (c + 2 * f + n) - (a + 2 * d + k), Y = (k + 2 * l + n) - (a + 2 * b + c);
    gx[i] = X; gy[i] = Y; m[i] = Math.hypot(X, Y);
  }
  return { gx, gy, m };
};
const grow = (src, w, h) => { const o = new Uint8Array(src.length);   // dilatation 3×3
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (src[i]) { o[i] = 1; continue; }
    if ((x > 0 && src[i - 1]) || (x < w - 1 && src[i + 1]) || (y > 0 && src[i - w]) || (y < h - 1 && src[i + w]) || (x > 0 && y > 0 && src[i - w - 1]) || (x < w - 1 && y > 0 && src[i - w + 1]) || (x > 0 && y < h - 1 && src[i + w - 1]) || (x < w - 1 && y < h - 1 && src[i + w + 1])) o[i] = 1; }
  return o; };
const shrink = (src, w, h) => { const inv = new Uint8Array(src.length); for (let i = 0; i < src.length; i++) inv[i] = 1 - src[i]; const g2 = grow(inv, w, h); for (let i = 0; i < g2.length; i++) g2[i] = 1 - g2[i]; return g2; };
// plus grande zone d'un masque → quadrilatère (ou null)
SC.maskQuad = (m, w, h, pad = 0) => {
  const lab = new Int32Array(w * h), st = new Int32Array(w * h); let best = 0, bestN = 0, cur = 0;
  for (let i = 0; i < m.length; i++) {
    if (!m[i] || lab[i]) continue; cur++; let sp = 0, n = 0; st[sp++] = i; lab[i] = cur;
    while (sp) { const p = st[--sp]; n++; const x = p % w, y = (p / w) | 0;
      if (x > 0 && m[p - 1] && !lab[p - 1]) { lab[p - 1] = cur; st[sp++] = p - 1; }
      if (x < w - 1 && m[p + 1] && !lab[p + 1]) { lab[p + 1] = cur; st[sp++] = p + 1; }
      if (y > 0 && m[p - w] && !lab[p - w]) { lab[p - w] = cur; st[sp++] = p - w; }
      if (y < h - 1 && m[p + w] && !lab[p + w]) { lab[p + w] = cur; st[sp++] = p + w; } }
    if (n > bestN) { bestN = n; best = cur; }
  }
  const ratio = bestN / (w * h);
  if (!best || ratio < 0.06 || ratio > 0.97) return null;
  const pts = []; let tL = 0, tR = 0, tT = 0, tB = 0;
  for (let y = 0; y < h; y++) { let a = -1, b = -1; const r = y * w;
    for (let x = 0; x < w; x++) if (lab[r + x] === best) { if (a < 0) a = x; b = x; }
    if (a >= 0) { pts.push([a - pad, y], [b + 1 + pad, y]); if (a === 0) tL++; if (b === w - 1) tR++; if (y === 0) tT++; if (y === h - 1) tB++; } }
  if ((tL > h * .5) + (tR > h * .5) + (tT > 0 && tB > 0 ? 1 : 0) >= 3) return null;
  const H = SC.hull(pts); if (H.length < 4) return null;
  let q = SC.order(H); if (!q) return null;
  let idx = q.map(p => H.findIndex(h2 => h2[0] === p[0] && h2[1] === p[1]));
  for (let it = 0; it < 3; it++) for (let k = 0; k < 4; k++) {
    let bi = idx[k], ba = -1;
    for (let j = 0; j < H.length; j++) { const tq = idx.map((v, z) => H[z === k ? j : v]); const a = SC.area(tq); if (a > ba && SC.convex(tq)) { ba = a; bi = j; } }
    idx[k] = bi;
  }
  q = SC.order(idx.map(i => H[i])); if (!q || !SC.convex(q)) return null;
  if (SC.area(q) < SC.area(H) * .8) return null;
  return q.map(p => [Math.max(0, Math.min(w, p[0])), Math.max(0, Math.min(h, p[1]))]);
};
// méthode B : « couleur papier » (clair et peu coloré) — feuille blanche sur bois, tissu, table colorée
SC.detectPaper = (d, w, h) => {
  const s = new Float32Array(w * h);
  for (let i = 0, j = 0; i < s.length; i++, j += 4) { const r = d[j], g = d[j + 1], b = d[j + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b); s[i] = Math.max(0, Math.min(255, (r * .299 + g * .587 + b * .114) - 1.3 * (mx - mn))); }
  const sb = SC.blur(s, w, h, 2), { t, sep } = SC.otsu(sb);
  if (sep < 0.04 * 255 / 2) return null;
  let m = new Uint8Array(w * h); for (let i = 0; i < m.length; i++) m[i] = sb[i] > t ? 1 : 0;
  m = grow(shrink(m, w, h), w, h);
  return SC.maskQuad(m, w, h);
};
// méthode C : zone fermée par des bords nets — feuille blanche sur table blanche, ombres, papier coloré
SC.detectEdges = (d, w, h, G) => {
  const g = SC.blur(SC.gray(d, w, h), w, h, 1), { m } = G || SC.sobel(g, w, h);
  const srt = Float32Array.from(m).sort(), thr = Math.max(14, srt[(m.length * .5) | 0] * 3.2);   // au-dessus du bruit de l'image
  let e = new Uint8Array(w * h); for (let i = 0; i < m.length; i++) e[i] = m[i] > thr ? 1 : 0;
  const st = new Int32Array(w * h);
  { const lb = new Int32Array(w * h); let cur = 0;   // on retire les petits points isolés (grain, bruit)
    for (let i = 0; i < e.length; i++) { if (!e[i] || lb[i]) continue; cur++; let sp = 0, n = 0; const mem = []; st[sp++] = i; lb[i] = cur;
      while (sp) { const p = st[--sp]; n++; mem.push(p); const x = p % w, y = (p / w) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; const j = yy * w + xx; if (e[j] && !lb[j]) { lb[j] = cur; st[sp++] = j; } } }
      if (n < 18) for (const p of mem) e[p] = 0; } }
  e = grow(grow(e, w, h), w, h);
  const out = new Uint8Array(w * h); let sp = 0;   // fond atteint depuis le bord de l'image
  const push = i => { if (!e[i] && !out[i]) { out[i] = 1; st[sp++] = i; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (sp) { const p = st[--sp], x = p % w, y = (p / w) | 0;
    if (x > 0) push(p - 1); if (x < w - 1) push(p + 1); if (y > 0) push(p - w); if (y < h - 1) push(p + w); }
  // tout ce qui n'est pas atteint depuis le bord = la feuille avec son contour (le texte à l'intérieur ne gêne plus)
  const inn = new Uint8Array(w * h); for (let i = 0; i < inn.length; i++) inn[i] = out[i] ? 0 : 1;
  return SC.maskQuad(shrink(inn, w, h), w, h, -1);
};
// note d'un cadre : force moyenne du bord perpendiculaire le long des 4 côtés (le plus faible compte double)
SC.edgeScore = (G, w, h, q) => {
  const per = [];
  for (let k = 0; k < 4; k++) {
    const a = q[k], b = q[(k + 1) % 4], L = dist(a, b); if (L < 4) return { s: 0, min: 0 };
    const nx = -(b[1] - a[1]) / L, ny = (b[0] - a[0]) / L; let s = 0, n = 0;
    for (let t = .08; t <= .92; t += .028) {
      let bm = 0;
      for (let o = -2; o <= 2; o++) { const x = Math.round(a[0] + (b[0] - a[0]) * t + nx * o), y = Math.round(a[1] + (b[1] - a[1]) * t + ny * o);
        if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue; const i = y * w + x, v = Math.abs(G.gx[i] * nx + G.gy[i] * ny); if (v > bm) bm = v; }
      s += bm; n++;
    }
    per.push(n ? s / n : 0);
  }
  const mn = Math.min(...per), mean = per.reduce((x, y) => x + y, 0) / 4;
  return { s: mn * .6 + mean * .4, min: mn };
};
SC.detect2 = (d, w, h) => {
  const g = SC.blur(SC.gray(d, w, h), w, h, 1), G = SC.sobel(g, w, h), A = w * h;
  const C = [];
  const tryq = f => { let q = null; try { q = f(); } catch (e) {} if (q) { const sc = SC.edgeScore(G, w, h, q); C.push({ q, ...sc, s: sc.s * (.8 + .2 * Math.sqrt(SC.area(q) / A)) }); } };
  tryq(() => SC.detect(d, w, h)); tryq(() => SC.detectPaper(d, w, h)); tryq(() => SC.detectEdges(d, w, h, G));
  C.sort((a, b) => b.s - a.s);
  const best = C.find(c => c.min >= 22);   // chaque côté doit vraiment suivre un bord
  return best ? best.q : null;
};
// Affinage : chaque côté est recalé sur le bord réel (au demi-pixel), puis les coins = intersections des droites
SC.refine = (g, w, h, q, R) => {
  R = R || Math.max(4, Math.hypot(w, h) * .02);
  const S = (x, y) => { if (x < 0 || y < 0 || x > w - 1.001 || y > h - 1.001) return NaN; const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
    return (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + w] * (1 - fx) + g[i + w + 1] * fx) * fy; };
  const cx = q.reduce((a, p) => a + p[0], 0) / 4, cy = q.reduce((a, p) => a + p[1], 0) / 4;
  const lines = [];
  for (let k = 0; k < 4; k++) {
    const a = q[k], b = q[(k + 1) % 4], L = dist(a, b);
    let nx = -(b[1] - a[1]) / L, ny = (b[0] - a[0]) / L;
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2; if ((cx - mx) * nx + (cy - my) * ny > 0) { nx = -nx; ny = -ny; }   // normale vers l'extérieur
    const P = [];
    const N = Math.max(12, Math.min(80, Math.round(L / 6)));
    for (let j = 0; j < N; j++) {
      const t = .06 + .88 * j / (N - 1), px = a[0] + (b[0] - a[0]) * t, py = a[1] + (b[1] - a[1]) * t;
      let bv = 0, bs = 0, sg = 0;
      for (let s = -R; s <= R; s += .5) { const v = S(px + nx * (s + 1.5), py + ny * (s + 1.5)) - S(px + nx * (s - 1.5), py + ny * (s - 1.5)); if (Math.abs(v) > bv) { bv = Math.abs(v); bs = s; sg = Math.sign(v); } }
      if (bv > 9) P.push([px + nx * bs, py + ny * bs, sg]);
    }
    if (P.length >= 8) {   // garde le sens de contraste majoritaire (évite le texte près du bord)
      const pos = P.filter(p => p[2] > 0).length, keep = pos >= P.length - pos ? 1 : -1;
      let Q = P.filter(p => p[2] === keep);
      let ln = null;
      for (let it = 0; it < 4 && Q.length >= 6; it++) {
        const n = Q.length, mx2 = Q.reduce((s, p) => s + p[0], 0) / n, my2 = Q.reduce((s, p) => s + p[1], 0) / n;
        let sxx = 0, syy = 0, sxy = 0; Q.forEach(p => { const dx = p[0] - mx2, dy = p[1] - my2; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; });
        const th = .5 * Math.atan2(2 * sxy, sxx - syy), ux = Math.cos(th), uy = Math.sin(th);
        ln = { x: mx2, y: my2, ux, uy };
        const r = Q.map(p => Math.abs(-(p[0] - mx2) * uy + (p[1] - my2) * ux)), md = r.slice().sort((x, y) => x - y)[r.length >> 1];
        const lim = Math.max(1, md * 2.5); const Q2 = Q.filter((p, i) => r[i] <= lim); if (Q2.length === Q.length) break; Q = Q2;
      }
      if (ln && Q.length >= Math.max(6, P.length * .35)) { lines.push(ln); continue; }
    }
    const L2 = dist(a, b); lines.push({ x: a[0], y: a[1], ux: (b[0] - a[0]) / L2, uy: (b[1] - a[1]) / L2, keep: 1 });   // bord peu net : côté d'origine
  }
  const meet = (l1, l2) => { const den = l1.ux * l2.uy - l1.uy * l2.ux; if (Math.abs(den) < 1e-6) return null; const t = ((l2.x - l1.x) * l2.uy - (l2.y - l1.y) * l2.ux) / den; return [l1.x + l1.ux * t, l1.y + l1.uy * t]; };
  const out = [];
  for (let k = 0; k < 4; k++) { const p = meet(lines[(k + 3) % 4], lines[k]); if (!p || dist(p, q[k]) > R * 3) out.push(q[k].slice()); else out.push([Math.max(0, Math.min(w, p[0])), Math.max(0, Math.min(h, p[1]))]); }
  const o = SC.order(out); if (!o || !SC.convex(o)) return q;
  const ar = SC.area(o) / SC.area(q); return ar > .8 && ar < 1.25 ? o : q;
};

// Homographie : rectangle (0,0)-(W,H) → quadrilatère q (coordonnées source)
SC.homog = (q, W, H) => {
  const s = [[0, 0], [W, 0], [W, H], [0, H]], A = [], b = [];
  for (let i = 0; i < 4; i++) { const [x, y] = s[i], [u, v] = q[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v); }
  for (let c = 0; c < 8; c++) {   // Gauss avec pivot
    let p = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < 8; r++) { if (r === c) continue; const f = A[r][c] / A[c][c]; if (!f) continue; for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k]; b[r] -= f * b[c]; }
  }
  return b.map((v, i) => v / A[i][i]);
};
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
SC.outSize = (q, cap = 2400) => {
  let W = Math.max(dist(q[0], q[1]), dist(q[3], q[2])), H = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  const k = Math.min(1, cap / Math.max(W, H)); return [Math.max(8, Math.round(W * k)), Math.max(8, Math.round(H * k))];
};
// Redressement (interpolation bilinéaire)
SC.warp = (src, sw, sh, q, W, H) => {
  const [a, b, c, d, e, f, g, h] = SC.homog(q, W, H), out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const X = x + .5, Y = y + .5, den = g * X + h * Y + 1;
    let u = (a * X + b * Y + c) / den - .5, v = (d * X + e * Y + f) / den - .5;
    u = Math.max(0, Math.min(sw - 1.001, u)); v = Math.max(0, Math.min(sh - 1.001, v));
    const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0, i0 = (y0 * sw + x0) * 4, i1 = i0 + sw * 4, o = (y * W + x) * 4;
    for (let k = 0; k < 3; k++) out[o + k] = (src[i0 + k] * (1 - fx) + src[i0 + 4 + k] * fx) * (1 - fy) + (src[i1 + k] * (1 - fx) + src[i1 + 4 + k] * fx) * fy;
    out[o + 3] = 255;
  }
  return out;
};
// Filtres : auto, doc, vif, photo, tableau, bw, encre, gray, eco, sepia, orig — puis réglages fins et netteté
SC.FILTRES = [
  ['auto', 'Auto couleur'], ['doc', 'Document'], ['vif', 'Couleurs vives'], ['photo', 'Photo'], ['tableau', 'Tableau blanc'],
  ['bw', 'Noir & blanc'], ['encre', 'Texte net'], ['gray', 'Gris'], ['eco', 'Éco encre'], ['sepia', 'Ancien'], ['orig', 'Original']
];
SC.illum = (d, w, h) => {   // carte d'éclairage : maximum local par bloc, élargi puis lissé
  const S = Math.max(8, Math.round(Math.max(w, h) / 90)), bw = Math.ceil(w / S), bh = Math.ceil(h / S);
  let m = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let mx = 0; const y1 = Math.min(h, (by + 1) * S), x1 = Math.min(w, (bx + 1) * S), st = S > 12 ? 2 : 1;
    for (let y = by * S; y < y1; y += st) for (let x = bx * S; x < x1; x += st) { const i = (y * w + x) * 4, l = d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114; if (l > mx) mx = l; }
    m[by * bw + bx] = mx;
  }
  for (let it = 0; it < 2; it++) { const o = new Float32Array(m.length);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { let mx = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = y + dy, xx = x + dx; if (yy >= 0 && yy < bh && xx >= 0 && xx < bw && m[yy * bw + xx] > mx) mx = m[yy * bw + xx]; } o[y * bw + x] = mx; }
    m = o; }
  m = SC.blur(m, bw, bh, 2);
  // carte pleine résolution par ligne (interpolation bilinéaire)
  return (x, y) => { const fx = Math.max(0, Math.min(bw - 1.001, x / S - .5)), fy = Math.max(0, Math.min(bh - 1.001, y / S - .5)), x0 = fx | 0, y0 = fy | 0, ax = fx - x0, ay = fy - y0, x1 = Math.min(bw - 1, x0 + 1), y1 = Math.min(bh - 1, y0 + 1);
    return (m[y0 * bw + x0] * (1 - ax) + m[y0 * bw + x1] * ax) * (1 - ay) + (m[y1 * bw + x0] * (1 - ax) + m[y1 * bw + x1] * ax) * ay; };
};
SC.boxMean = (g, w, h, r) => {   // moyenne locale par image intégrale
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) { let s = 0; for (let x = 0; x < w; x++) { s += g[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + s; } }
  const o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) { const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) { const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      o[y * w + x] = (I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0)); } }
  return o;
};
SC.sharpen = (d, w, h, amt) => {   // masque flou (unsharp) sur les 3 canaux
  if (amt <= 0 || w < 3 || h < 3) return;
  const n = w * h, ch = new Float32Array(n);
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < n; i++) ch[i] = d[i * 4 + c];
    const b = SC.blur(ch, w, h, 1);
    for (let i = 0; i < n; i++) { const v = ch[i] + (ch[i] - b[i]) * amt; d[i * 4 + c] = v < 0 ? 0 : v > 255 ? 255 : v; }
  }
};
SC.NET = { auto: .55, doc: .7, vif: .5, photo: .35, tableau: .6, bw: .5, encre: 0, gray: .6, eco: .4, sepia: .3, orig: 0 };
SC.filter = (d, w, h, mode, adj) => {
  adj = adj || {};
  const cl = v => v < 0 ? 0 : v > 255 ? 255 : v, n = w * h;
  if (mode !== 'orig') {
    const flat = mode !== 'photo' && mode !== 'sepia';
    const ill = flat ? SC.illum(d, w, h) : null;
    // niveaux automatiques (photo / ancien) : 1 % et 99 %
    let lo = 0, hi = 255;
    if (!flat) { const hs = new Uint32Array(256); for (let i = 0; i < n; i += 3) hs[(d[i * 4] * .299 + d[i * 4 + 1] * .587 + d[i * 4 + 2] * .114) | 0]++;
      const tot = Math.ceil(n / 3); let a = 0; for (lo = 0; lo < 255 && (a += hs[lo]) < tot * .01; lo++); a = 0; for (hi = 255; hi > 0 && (a += hs[hi]) < tot * .01; hi--); if (hi - lo < 40) { lo = 0; hi = 255; } }
    // balance des blancs : la couleur moyenne du papier devient blanc neutre (papier jauni, lumière chaude)
    let gr = 1, gg = 1, gb = 1;
    if (flat && mode !== 'bw' && mode !== 'gray' && mode !== 'encre' && mode !== 'eco') {
      let sr = 0, sg = 0, sb = 0, c = 0; const st = Math.max(1, Math.round(Math.sqrt(n / 40000)));
      for (let y = 0; y < h; y += st) for (let x = 0; x < w; x += st) { const i = (y * w + x) * 4, k = 255 / Math.max(48, ill(x, y)), r = d[i] * k, g = d[i + 1] * k, b = d[i + 2] * k; if (r * .299 + g * .587 + b * .114 > 225) { sr += r; sg += g; sb += b; c++; } }
      if (c > 50) { const m = (sr + sg + sb) / 3 / c; gr = Math.min(1.35, m / (sr / c)); gg = Math.min(1.35, m / (sg / c)); gb = Math.min(1.35, m / (sb / c)); }
    }
    let L = null; if (mode === 'encre') L = new Float32Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, k = flat ? 255 / Math.max(48, ill(x, y)) : 255 / (hi - lo), o = flat ? 0 : lo;
      let r = (d[i] - o) * k * gr, g = (d[i + 1] - o) * k * gg, b = (d[i + 2] - o) * k * gb;
      const l = r * .299 + g * .587 + b * .114;
      if (mode === 'auto' || mode === 'vif' || mode === 'doc' || mode === 'tableau') {
        const fade = l > 200 ? Math.max(0, 1 - (l - 200) / 40) : 1;   // papier : on retire la couleur parasite
        const sat = 1 + ({ auto: .25, vif: .7, doc: .1, tableau: .9 }[mode]) * fade - (mode === 'doc' ? (1 - fade) : (1 - fade) * .6);
        r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat;
        const [bl, ct, wp] = { auto: [28, 1.13, 230], vif: [24, 1.12, 238], doc: [40, 1.22, 226], tableau: [30, 1.25, 215] }[mode];
        const c = v => { v = (v - bl) * ct; return v > wp ? 255 : v; };
        d[i] = cl(c(r)); d[i + 1] = cl(c(g)); d[i + 2] = cl(c(b));
      } else if (mode === 'photo') {
        const sat = 1.12; d[i] = cl(l + (r - l) * sat); d[i + 1] = cl(l + (g - l) * sat); d[i + 2] = cl(l + (b - l) * sat);
      } else if (mode === 'sepia') {
        const v = cl(l * 1.05); d[i] = cl(v * .95 + 28); d[i + 1] = cl(v * .82 + 22); d[i + 2] = cl(v * .62 + 12);
      } else if (mode === 'eco') {
        let v = (l - 30) * 1.1; v = v > 225 ? 255 : 255 - (255 - cl(v)) * .55; d[i] = d[i + 1] = d[i + 2] = cl(v);
      } else if (mode === 'encre') { L[y * w + x] = cl(l); }
      else {
        let v = l;
        if (mode === 'bw') { const t = Math.max(0, Math.min(1, (v - 120) / 85)); v = 255 * t * t * (3 - 2 * t); }
        else { v = (v - 22) * 1.12; if (v > 238) v = 255; }
        d[i] = d[i + 1] = d[i + 2] = cl(v);
      }
    }
    if (mode === 'encre') {   // seuil adaptatif local (texte très net, fond pur)
      const M = SC.boxMean(L, w, h, Math.max(6, Math.round(Math.max(w, h) / 70)));
      for (let j = 0; j < n; j++) { const t = (L[j] - (M[j] - 14)) / 10, v = t <= 0 ? 0 : t >= 1 ? 255 : 255 * t; const v2 = L[j] > 200 ? 255 : v; d[j * 4] = d[j * 4 + 1] = d[j * 4 + 2] = v2; }
    }
  }
  // réglages fins : luminosité / contraste (-50..50)
  const bri = (adj.b || 0) * 1.6, con = 1 + (adj.c || 0) / 60;
  if (bri || con !== 1) for (let j = 0; j < n * 4; j += 4) for (let c = 0; c < 3; c++) d[j + c] = cl((d[j + c] - 128) * con + 128 + bri);
  // netteté : par filtre, plus le réglage (0..100, 50 = normal)
  const net = (SC.NET[mode] || 0) * ((adj.s == null ? 50 : adj.s) / 50);
  if (net > 0.02) SC.sharpen(d, w, h, net);
};

/* ---------- Titre automatique : genre de document + numéro + émetteur + date, lu dans le texte ---------- */
SC.TYPES = [
  [/note\s+de\s+cr[ée]dit|creditnota|credit\s+note/i, 'Note de crédit'],
  [/\bfacture\b|\binvoice\b|\bfactuur\b/i, 'Facture'],
  [/\bdevis\b|\bofferte\b|\bquotation\b|\bestimation\b/i, 'Devis'],
  [/bon\s+de\s+commande|bestelbon|purchase\s+order/i, 'Bon de commande'],
  [/bon\s+de\s+livraison|leveringsbon|delivery\s+note/i, 'Bon de livraison'],
  [/fiche\s+de\s+(paie|salaire)|bulletin\s+de\s+(paie|salaire)|loonbrief|loonfiche|payslip/i, 'Fiche de paie'],
  [/contrat\s+de\s+(bail|location)|\bbail\b|huurcontract|huurovereenkomst/i, 'Bail'],
  [/\bcontrat\b|overeenkomst|\bcontract\b/i, 'Contrat'],
  [/certificat\s+m[ée]dical|medisch\s+attest/i, 'Certificat médical'],
  [/\bordonnance\b|voorschrift|prescription\s+m[ée]dicale/i, 'Ordonnance'],
  [/attestation|\battest\b|certificat\b/i, 'Attestation'],
  [/relev[ée]\s+de\s+compte|extrait\s+de\s+compte|rekeninguittreksel|bank\s+statement/i, 'Relevé bancaire'],
  [/avertissement[- ]extrait\s+de\s+r[ôo]le|avis\s+d.imposition|aanslagbiljet|spf\s+finances|imp[ôo]ts?\b/i, 'Impôts'],
  [/perception\s+imm[ée]diate|proc[eè]s[- ]verbal|\bamende\b|\bboete\b|\bpv\s+n/i, 'Amende'],
  [/mise\s+en\s+demeure|\brappel\b|herinnering|ingebrekestelling/i, 'Rappel de paiement'],
  [/assurance|verzekering|police\s+n/i, 'Assurance'],
  [/ticket\s+de\s+caisse|kassaticket|\bre[çc]u\b|\breceipt\b|\bkasticket\b/i, 'Ticket de caisse'],
  [/convocation|oproeping/i, 'Convocation'],
  [/bulletin\s+scolaire|rapport\s+scolaire|\bbulletin\b/i, 'Bulletin'],
  [/curriculum|\bcv\b/i, 'CV'],
  [/garantie|warranty/i, 'Garantie'],
  [/carte\s+d.embarquement|boarding\s+pass|\bbillet\b|e-ticket/i, 'Billet'],
  [/mode\s+d.emploi|\bnotice\b|handleiding|manual\b/i, 'Notice'],
  [/ingr[ée]dients|pr[ée]paration\s*:/i, 'Recette'],
  [/\bmenu\b|\bcarte\s+des\b/i, 'Menu'],
  [/ordre\s+du\s+jour|compte[- ]rendu|proc[eè]s[- ]verbal\s+de\s+r[ée]union|notulen/i, 'Compte rendu']
];
SC.MOIS = { janvier: 1, février: 2, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, août: 8, aout: 8, septembre: 9, octobre: 10, novembre: 11, décembre: 12, decembre: 12, januari: 1, februari: 2, maart: 3, april: 4, mei: 5, juni: 6, juli: 7, augustus: 8, oktober: 10, december: 12, november: 11, september: 9, october: 10, january: 1, february: 2, march: 3, june: 6, july: 7, august: 8 };
// émetteurs connus (Belgique surtout) : un vrai nom vaut mieux qu'une ligne d'adresse
SC.EMET = [
  [/engie|electrabel/i, 'Engie'], [/luminus/i, 'Luminus'], [/totalenergies|lampiris/i, 'TotalEnergies'], [/eneco/i, 'Eneco'], [/mega\b/i, 'Mega'], [/octa\+/i, 'Octa+'], [/sibelga/i, 'Sibelga'], [/ores\b/i, 'ORES'], [/fluvius/i, 'Fluvius'],
  [/vivaqua/i, 'Vivaqua'], [/\bswde\b/i, 'SWDE'], [/proximus/i, 'Proximus'], [/\borange\b/i, 'Orange'], [/telenet/i, 'Telenet'], [/\bvoo\b/i, 'VOO'], [/\bbase\b.*(mobile|gsm)|base\s+company/i, 'BASE'], [/scarlet/i, 'Scarlet'], [/digi\b/i, 'Digi'],
  [/spf\s+finances|fod\s+financi[eë]n|myminfin/i, 'SPF Finances'], [/solidaris/i, 'Solidaris'], [/partenamut/i, 'Partenamut'], [/mutualit[ée]\s+chr[ée]tienne|\bmc\.be|christelijke\s+mutualiteit|\bcm\b/i, 'Mutualité chrétienne'], [/helan/i, 'Helan'], [/\bcaami\b|hziv/i, 'CAAMI'],
  [/\bonem\b|\brva\b/i, 'ONEM'], [/\bcpas\b|\bocmw\b/i, 'CPAS'], [/securex/i, 'Securex'], [/partena/i, 'Partena'], [/acerta/i, 'Acerta'], [/liantis/i, 'Liantis'], [/\bsd\s?worx/i, 'SD Worx'], [/actiris/i, 'Actiris'], [/\bforem\b/i, 'Forem'], [/\bvdab\b/i, 'VDAB'],
  [/belfius/i, 'Belfius'], [/bnp\s+paribas|\bfortis\b/i, 'BNP Paribas Fortis'], [/\bing\s+(belgique|belgi[eë]|bank)|\bing\.be/i, 'ING'], [/\bkbc\b/i, 'KBC'], [/argenta/i, 'Argenta'], [/crelan/i, 'Crelan'], [/beobank/i, 'Beobank'], [/\bbpost\b/i, 'bpost'],
  [/ag\s+insurance/i, 'AG Insurance'], [/\baxa\b/i, 'AXA'], [/ethias/i, 'Ethias'], [/\bp\s?&\s?v\b/i, 'P&V'], [/baloise/i, 'Baloise'], [/allianz/i, 'Allianz'],
  [/\bsncb\b|\bnmbs\b/i, 'SNCB'], [/\bstib\b|\bmivb\b/i, 'STIB'], [/de\s+lijn/i, 'De Lijn'], [/\btec\b/i, 'TEC'], [/brussels\s+airlines/i, 'Brussels Airlines'], [/ryanair/i, 'Ryanair'], [/\btui\b/i, 'TUI'],
  [/amazon/i, 'Amazon'], [/bol\.com/i, 'Bol.com'], [/coolblue/i, 'Coolblue'], [/mediamarkt/i, 'MediaMarkt'], [/vanden\s?borre/i, 'Vanden Borre'], [/krefel/i, 'Krëfel'], [/\bikea\b/i, 'IKEA'], [/colruyt/i, 'Colruyt'], [/delhaize/i, 'Delhaize'], [/carrefour/i, 'Carrefour'], [/\baldi\b/i, 'Aldi'], [/\blidl\b/i, 'Lidl'], [/\bmakro\b/i, 'Makro'], [/action\b.*\bbv\b|\baction\.com/i, 'Action'],
  [/haythem\s*food/i, 'Haythem Food'], [/media\s*shield/i, 'Media Shield']
];
// de quoi parle le document
SC.SUJETS = [
  [/[ée]lectricit[ée]|elektriciteit|\bkwh\b/i, 'électricité'], [/\bgaz\b|aardgas/i, 'gaz'], [/\beau\b|\bwater\b|\bm3\b|m³/i, 'eau'], [/internet|fibre|\bwi-?fi\b|t[ée]l[ée]vision|\btv\b/i, 'internet'], [/abonnement\s+mobile|\bgsm\b|carte\s+sim|forfait\s+mobile/i, 'mobile'],
  [/\bloyer\b|\bhuur\b|charges\s+locatives/i, 'loyer'], [/v[ée]hicule|voiture|immatriculation|plaque|\bauto\b|\bomnium\b/i, 'voiture'], [/habitation|incendie|woning|\bbrand\b/i, 'habitation'],
  [/hospitalisation|consultation|\bsoins?\b|m[ée]decin|pharmacie|dentiste|kin[ée]/i, 'santé'], [/[ée]cole|scolaire|\bschool\b|universit/i, 'école'], [/salaire|\bloon\b|r[ée]mun[ée]ration|p[ée]cule/i, 'salaire'],
  [/pr[êe]t\s+hypoth|cr[ée]dit\s+hypoth|hypothe(ek|cair)|\blening\b|pr[êe]t\s+personnel/i, 'prêt'], [/allocations?\s+familiales|groeipakket|famiris|famiwal|kidslife/i, 'allocations familiales'], [/ch[ôo]mage|werkloosheid/i, 'chômage'],
  [/pr[ée]compte\s+immobilier|onroerende\s+voorheffing/i, 'précompte immobilier'], [/imp[ôo]t\s+des\s+personnes|personenbelasting|d[ée]claration\s+fiscale|\bipp\b/i, 'impôt sur les revenus'],
  [/stationnement|parking/i, 'stationnement'], [/exc[eè]s\s+de\s+vitesse|\bradar\b|snelheid/i, 'excès de vitesse'], [/train|\bsncb\b|\bnmbs\b/i, 'train'], [/\bvol\b|flight|a[ée]roport|embarquement/i, 'vol'],
  [/\blivraison|\bcolis\b|pakket/i, 'livraison'], [/\br[ée]paration|\bentretien\b|herstelling/i, 'réparation'], [/\btravaux\b|r[ée]novation|verbouwing/i, 'travaux']
];
// cartes (mode Carte) : reconnues avant le reste
SC.CARTES = [
  [/identiteitskaart|carte\s+d.?identit|identity\s+card|personalausweis|\bbelgi(que|[eë]).{0,40}\bidentit/i, 'Carte d’identité'],
  [/permis\s+de\s+conduire|rijbewijs|driving\s+licen[cs]e|f[üu]hrerschein/i, 'Permis de conduire'],
  [/passeport|paspoort|passport/i, 'Passeport'],
  [/titre\s+de\s+s[ée]jour|verblijfs(titel|kaart)|residence\s+permit/i, 'Titre de séjour'],
  [/certificat\s+d.?immatriculation|inschrijvingsbewijs|carte\s+grise/i, 'Carte grise'],
  [/carte\s+europ[ée]enne|european\s+health|\behic\b|mutualit|ziekenfonds/i, 'Carte de mutuelle'],
  [/carte\s+(de\s+)?(fid[ée]lit[ée]|client)|klantenkaart/i, 'Carte de fidélité'],
  [/\bvisa\b|mastercard|maestro|bancontact|valid\s+thru|expires?\s+end|debit\b/i, 'Carte bancaire']
];
SC.MOISN = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
// types où la période compte (on écrit « novembre 2026 », jamais une suite de chiffres)
const PERIODE = /^(Facture|Note de crédit|Fiche de paie|Relevé bancaire|Impôts|Rappel de paiement|Ticket de caisse|Assurance|Bulletin)$/;
const VIDES = new Set('dans pour avec sans sous chez entre leurs cette notre votre vous nous elles sont avoir être était être plus moins tout toute tous toutes faire fait comme mais donc ainsi aussi alors après avant depuis encore jamais toujours votre total date page client numéro montant adresse merci madame monsieur bonjour cordialement selon partir dont autre autres même mêmes leur leurs celui celle ceux elle elles sera seront peut doit doivent quel quelle quels quelles here there with from this that your have been will which their about would these other into more some only than then them were what when where while shall voor zijn deze niet door naar maar heeft worden wordt over geen meer onder tussen uw jullie onze'.split(' '));
SC.titre = (texte, genre) => {
  const t = (texte || '').replace(/— Page \d+ —/g, '').replace(/[ \t]+/g, ' ');
  const lignes = t.split(/\n/).map(l => l.trim()).filter(l => l.length > 1);
  if (!lignes.length) return '';
  const debut = lignes.slice(0, 25).join('\n'), propre = s => s.replace(/[\\/:*?"<>|_]+/g, ' ').replace(/\s+/g, ' ').replace(/^[\s\-–—.,;]+|[\s\-–—.,;]+$/g, '').trim();
  const joli = s => (s === s.toUpperCase() && s.length > 3) ? s.toLowerCase().replace(/(^|\s|-|')\S/g, c => c.toUpperCase()) : s;
  const lisible = s => { const L = (s.match(/[A-Za-zÀ-ÿ]/g) || []).length; return L >= 3 && L / s.length > .7 && /[aeiouyàâéèêëîïôûù]/i.test(s) && !/(.)\1{3,}/.test(s); };
  // émetteur : nom connu, sinon première ligne « nom propre » du haut (pas d'adresse, pas de chiffres)
  let qui = ''; for (const [re, nom] of SC.EMET) if (re.test(debut)) { qui = nom; break; }
  if (!qui) for (const [re, nom] of SC.EMET) if (re.test(t)) { qui = nom; break; }
  const bruit = /\b(rue|avenue|av\.|chauss[ée]e|boulevard|bd|place|straat|laan|steenweg|t[ée]l|tel\.|gsm|fax|e-?mail|www|http|tva|btw|iban|bic|bce|kbo|page|date|client|total|montant|objet|facture|madame|monsieur|cher|ch[eè]re|bruxelles|brussel)\b|@|\d/i;
  let ligne1 = '';   // première ligne « nom propre » du haut
  for (const l0 of lignes.slice(0, 10)) {
    for (const l of l0.split(/\s[—–|\-]\s|,/)) { const s = propre(l);
      if (s.length < 3 || s.length > 32 || bruit.test(s) || !lisible(s) || s.split(' ').length > 4) continue;
      ligne1 = joli(s); break; }
    if (ligne1) break;
  }
  const connu = !!qui; if (!qui) qui = ligne1;
  // cartes
  for (const [re, nom] of SC.CARTES) if (re.test(t)) return nom === 'Carte bancaire' || nom === 'Carte de mutuelle' || nom === 'Carte de fidélité' ? [nom, qui].filter(Boolean).join(' – ') : nom;
  if (genre === 'carte') {   // carte de visite : un nom + un téléphone ou un e-mail
    if (/@|\+?\d[\d .\/]{7,}/.test(t) && ligne1) return 'Carte de visite – ' + ligne1 + (connu && qui !== ligne1 ? ' (' + qui + ')' : '');
    return qui ? 'Carte – ' + qui : '';
  }
  // genre du document
  let type = '';
  for (const [re, nom] of SC.TYPES) if (re.test(debut)) { type = nom; break; }
  if (!type) for (const [re, nom] of SC.TYPES) if (re.test(t)) { type = nom; break; }
  // sujet
  let sujet = ''; for (const [re, nom] of SC.SUJETS) if (re.test(t)) { sujet = nom; break; }
  if (type === 'Impôts' && (sujet === 'impôt sur les revenus' || sujet === 'précompte immobilier')) { type = ''; sujet = sujet.charAt(0).toUpperCase() + sujet.slice(1); }
  // période en toutes lettres : « novembre 2026 »
  let mois = 0, an = 0;
  const dm = t.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](20\d{2})\b/);
  if (dm && +dm[2] >= 1 && +dm[2] <= 12) { mois = +dm[2]; an = +dm[3]; }
  if (!mois) { const dl = t.match(/\b(?:\d{1,2}\s+)?([a-zéûè]+)\s+(20\d{2})\b/i); if (dl && SC.MOIS[dl[1].toLowerCase()]) { mois = SC.MOIS[dl[1].toLowerCase()]; an = +dl[2]; } }
  const periode = mois ? SC.MOISN[mois - 1] + ' ' + an : '';
  // courrier : la ligne « Objet : … »
  const om = t.match(/(?:^|\n)\s*(?:objet|concerne|betreft|subject|re)\s*:\s*([^\n]{3,70})/i);
  const objet = om ? propre(om[1].replace(/\b(n[°o]|ref|réf)\.?\s*[\w\-\/.]*\d[\w\-\/.]*/gi, '').replace(/\d[\d\-\/. ]{3,}/g, '')) : '';
  let titre = '';
  if (/^(Compte rendu|Recette|CV|Notice|Menu|Convocation|Attestation|Contrat|Certificat médical|Bulletin)$/.test(type)) {   // ces documents ont un vrai titre : on le garde
    const tw = type.split(' ')[0].toLowerCase();
    const tl = lignes.slice(0, 8).map(propre).map(x => x.replace(new RegExp('^' + tw + '\\S*\\s*(?:(?:de\\s+la|du|des|de|d\'|pour|:)\\s*)?', 'i'), '')).find(x => x.length >= 4 && x.length <= 60 && lisible(x) && !/\d{3,}/.test(x) && !SC.TYPES.some(([re]) => re.test(x)));
    if (tl) return propre(type + ' – ' + joli(tl.length > 50 ? tl.slice(0, 50).replace(/\s\S*$/, '') : tl)).slice(0, 80);
  }
  if (type === 'Ticket de caisse' && dm) titre = [type + (qui ? ' ' + qui : ''), +dm[1] + ' ' + SC.MOISN[+dm[2] - 1] + ' ' + dm[3]].join(' – ');
  else if (type) titre = [type + (qui ? ' ' + qui : ''), sujet, PERIODE.test(type) ? periode : ''].filter(Boolean).join(' – ');
  else if (objet && lisible(objet)) titre = [objet.charAt(0).toUpperCase() + objet.slice(1), qui].filter(Boolean).join(' – ');
  else if (sujet && qui) titre = [qui, sujet].join(' – ');
  else {
    // pas de genre : la première vraie ligne de titre (des mots, pas des chiffres)
    const tl = lignes.slice(0, 8).map(propre).find(x => x.length >= 6 && x.length <= 60 && lisible(x) && !/\d{3,}/.test(x) && x.split(' ').length >= 2);
    if (tl) titre = joli(tl.length > 50 ? tl.slice(0, 50).replace(/\s\S*$/, '') : tl);
    else {   // sinon : les mots qui reviennent le plus
      const n = {}; (t.toLowerCase().match(/[a-zà-ÿ]{5,}/g) || []).forEach(w => { if (!VIDES.has(w)) n[w] = (n[w] || 0) + 1; });
      const top = Object.entries(n).filter(([, c]) => c >= 2).sort((x, y) => y[1] - x[1]).slice(0, 3).map(x => x[0]);
      if (top.length) titre = (qui ? qui + ' – ' : '') + top.join(', ');
      else if (qui) titre = qui;
    }
  }
  return propre(titre).replace(/\s+–\s+–\s+/g, ' – ').slice(0, 80);
};

/* ---------- PDF (sans bibliothèque) : une image JPEG par page ---------- */
SC.pdf = (pages, size) => {   // pages : [{ jpg: Uint8Array, w, h }] ; size : 'auto' (largeur A4) | 'a4' | 'lettre'
  const te = s => new TextEncoder().encode(s), parts = [], offs = []; let len = 0;
  const add = b => { if (typeof b === 'string') b = te(b); parts.push(b); len += b.length; };
  const obj = (n, body) => { offs[n] = len; add(`${n} 0 obj\n`); body(); add('\nendobj\n'); };
  add('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'.replace(/[\u0080-ÿ]/g, '*'));
  const n = pages.length, kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  obj(1, () => add('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => add(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`));
  pages.forEach((p, i) => {
    const pn = 3 + i * 3, cn = pn + 1, im = pn + 2;
    let PW = 595.28, PH = +(PW * p.h / p.w).toFixed(2), iw = PW, ih = PH, ix = 0, iy = 0;   // largeur A4, hauteur selon la page
    if (size === 'a4' || size === 'lettre') {   // vrai format de page : l'image est centrée, sans déformation
      [PW, PH] = size === 'a4' ? [595.28, 841.89] : [612, 792]; if (p.w > p.h) [PW, PH] = [PH, PW];
      const k = Math.min(PW / p.w, PH / p.h); iw = +(p.w * k).toFixed(2); ih = +(p.h * k).toFixed(2); ix = +((PW - iw) / 2).toFixed(2); iy = +((PH - ih) / 2).toFixed(2);
    }
    const cs = `q ${iw} 0 0 ${ih} ${ix} ${iy} cm /Im0 Do Q`;
    obj(pn, () => add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /XObject << /Im0 ${im} 0 R >> >> /Contents ${cn} 0 R >>`));
    obj(cn, () => { add(`<< /Length ${cs.length} >>\nstream\n`); add(cs); add('\nendstream'); });
    obj(im, () => { add(`<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpg.length} >>\nstream\n`); add(p.jpg); add('\nendstream'); });
  });
  const total = 3 + n * 3, xref = len;
  add(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let i = 1; i < total; i++) add(String(offs[i]).padStart(10, '0') + ' 00000 n \n');
  add(`trailer\n<< /Size ${total} /Root 1 0 R /Producer (Notes) >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(len); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
// Relit les images d'un PDF créé par le scanner (pour l'afficher sans lecteur PDF)
SC.pdfImages = buf => {
  const u = new Uint8Array(buf), s = new TextDecoder('latin1').decode(u), re = /\/Filter \/DCTDecode \/Length (\d+) >>\nstream\n/g, out = []; let m;
  while ((m = re.exec(s))) { const st = m.index + m[0].length, n = +m[1]; out.push(u.slice(st, st + n)); re.lastIndex = st + n; }
  return out;
};

if (typeof document === 'undefined') return;   // (tests hors navigateur)

/* ---------- Interface ---------- */
const css = `
#scan{background:#000;z-index:30;color:#fff;user-select:none;-webkit-user-select:none}
#scan .pane{position:absolute;inset:0;display:flex;flex-direction:column}
#scan .stop{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:calc(10px + env(safe-area-inset-top)) 14px 10px;position:relative;z-index:3}
#scan .stop h3{margin:0;font-size:16px;font-weight:600;flex:1;text-align:center;color:var(--gold2)}
#scan .rb{width:42px;height:42px;border-radius:50%;background:#ffffff14;display:grid;place-items:center;font-size:18px;color:#fff;backdrop-filter:blur(10px)}
#scan .rb.on{background:var(--gold);color:#1d1503}
#scan .gb{color:var(--gold2);font-weight:700;font-size:16px;padding:8px 6px}
#scan .gb.p{background:linear-gradient(135deg,var(--gold2),var(--gold) 50%,var(--gold3));color:#1d1503;border-radius:20px;padding:9px 16px}
#scCam .vw{position:absolute;inset:0;overflow:hidden;background:#000}
#scV{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
#scO{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
#scCam .stop{background:linear-gradient(#000a,#0000)}
#scHint{position:absolute;left:50%;top:calc(66px + env(safe-area-inset-top));transform:translateX(-50%);background:#000a;padding:7px 14px;border-radius:18px;font-size:14px;white-space:nowrap;z-index:3;transition:background .2s}
#scHint.ok{background:#d9b25acc;color:#1d1503;font-weight:700}
#scCam .sbot{position:absolute;left:0;right:0;bottom:0;padding:14px 22px calc(20px + env(safe-area-inset-bottom));background:linear-gradient(#0000,#000c 40%);z-index:3}
#scCam .mode{display:flex;justify-content:center;gap:6px;margin-bottom:14px}
#scCam .mode button{padding:6px 14px;border-radius:16px;font-size:13px;font-weight:600;color:#ddd;background:#ffffff14}
#scCam .mode button.on{background:#d9b25a33;color:var(--gold2);box-shadow:inset 0 0 0 1px #d9b25a88}
#scCam .row{display:flex;align-items:center;justify-content:space-between}
#scShot{width:76px;height:76px;border-radius:50%;border:4px solid #fff;background:none;position:relative;transition:transform .12s}
#scShot:after{content:'';position:absolute;inset:5px;border-radius:50%;background:#fff;transition:background .2s}
#scShot.auto:after{background:var(--gold)}
#scShot:active{transform:scale(.92)}
#scShot .ring{position:absolute;inset:-8px;border-radius:50%;border:3px solid transparent;border-top-color:var(--gold2);opacity:0}
#scShot.arm .ring{opacity:1;animation:scspin .9s linear infinite}
@keyframes scspin{to{transform:rotate(360deg)}}
#scGal,#scPg{width:58px;height:58px;border-radius:12px;background:#ffffff14;display:grid;place-items:center;font-size:22px;position:relative;overflow:visible}
#scPg img{width:100%;height:100%;object-fit:cover;border-radius:12px;box-shadow:0 0 0 2px #fff}
#scPg b{position:absolute;top:-8px;right:-8px;min-width:24px;height:24px;border-radius:12px;background:var(--gold);color:#1d1503;font-size:13px;display:grid;place-items:center;padding:0 6px}
#scPg.pop{animation:scpop .45s var(--ease)}
@keyframes scpop{40%{transform:scale(1.18)}}
#scFlash{position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none;z-index:4}
#scFlash.go{animation:scfl .35s}
@keyframes scfl{20%{opacity:.85}}
#scNoCam{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:#bbb;text-align:center;padding:30px;font-size:15px}
#scCrop .stage,#scRev .stage{flex:1;position:relative;overflow:hidden;touch-action:none}
#scCropC{position:absolute}
#scCropS{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
#scCropS polygon{fill:#d9b25a22;stroke:var(--gold2);stroke-width:2.5}
#scCropS circle.h{fill:#d9b25a44;stroke:#fff;stroke-width:2.5}
#scCropS circle.t{fill:transparent;stroke:none}
#scLoupe{position:absolute;width:110px;height:110px;border-radius:50%;box-shadow:0 0 0 3px var(--gold2),0 8px 24px #000c;pointer-events:none;display:none;background:#000}
#scan .tools{display:flex;justify-content:space-around;padding:10px 8px calc(14px + env(safe-area-inset-bottom));background:#0e0e12;border-top:1px solid #ffffff10}
#scan .tools button{display:flex;flex-direction:column;align-items:center;gap:4px;font-size:12px;color:#ddd;min-width:60px;padding:4px}
#scan .tools button b{font-size:22px;font-weight:400;line-height:1}
#scan .tools button:active{opacity:.6}
#scan .tools button.dg{color:#ff6b61}
#scRev .stage{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;touch-action:pan-x;scrollbar-width:none}
#scRev .stage::-webkit-scrollbar{display:none}
#scRev .sl{flex:0 0 100%;scroll-snap-align:center;display:flex;align-items:center;justify-content:center;padding:10px 22px;position:relative}
#scRev .sl img{max-width:100%;max-height:100%;box-shadow:0 10px 30px #000c;border-radius:3px;background:#fff}
#scRev .sl .wait{position:absolute;color:#aaa;font-size:14px}
#scRev .filt{display:flex;gap:10px;overflow-x:auto;padding:10px 14px 6px;scrollbar-width:none}
#scRev .filt::-webkit-scrollbar{display:none}
#scRev .filt button{flex:0 0 auto;width:64px;display:flex;flex-direction:column;align-items:center;gap:5px;font-size:11px;font-weight:600;color:#bbb;background:none;padding:0}
#scRev .filt button i{display:block;width:58px;height:72px;border-radius:10px;overflow:hidden;background:#2a2a2e;box-shadow:0 0 0 1px #ffffff1f;transition:transform .15s,box-shadow .15s}
#scRev .filt button i img{width:100%;height:100%;object-fit:cover;display:block}
#scRev .filt button.on{color:#fff}
#scRev .filt button.on i{box-shadow:0 0 0 2.5px var(--acc,#e5b400),0 6px 16px #0008;transform:translateY(-2px)}
#scRev .filt button.all i{display:grid;place-items:center;font-style:normal;font-size:22px;background:#ffffff10;color:var(--acc,#e5b400)}
#scRev .filt button span{white-space:nowrap;max-width:64px;overflow:hidden;text-overflow:ellipsis}
#scAdj{display:none;padding:6px 18px 4px;gap:4px;flex-direction:column}
#scAdj.on{display:flex}
#scAdj label{display:flex;align-items:center;gap:12px;font-size:13px;color:#ccc}
#scAdj label b{width:86px;font-weight:600}
#scAdj label em{width:30px;text-align:right;font-style:normal;color:#888;font-variant-numeric:tabular-nums}
#scAdj input{flex:1;accent-color:var(--acc,#e5b400);height:28px}
#scAdj .ar{display:flex;gap:8px;justify-content:flex-end;padding-top:2px}
#scAdj .ar button{padding:6px 12px;border-radius:14px;background:#ffffff14;font-size:12.5px;font-weight:600;color:#ddd}
#scRev .tools button.on{color:var(--acc,#e5b400)}
#scRev .thumbs{display:flex;gap:8px;overflow-x:auto;padding:6px 14px 8px;scrollbar-width:none}
#scRev .thumbs button{flex:0 0 auto;width:46px;height:60px;border-radius:6px;overflow:hidden;position:relative;background:#222;box-shadow:0 0 0 1px #ffffff22}
#scRev .thumbs button.on{box-shadow:0 0 0 2.5px var(--gold2)}
#scRev .thumbs img{width:100%;height:100%;object-fit:cover}
#scRev .thumbs i{position:absolute;bottom:2px;right:3px;font-style:normal;font-size:10px;font-weight:700;background:#000a;border-radius:6px;padding:0 4px}
#scRev .thumbs .add{display:grid;place-items:center;font-size:24px;color:var(--gold2);background:#ffffff0c}
#scBusy{position:absolute;inset:0;background:#000b;display:none;align-items:center;justify-content:center;flex-direction:column;gap:14px;z-index:10;font-size:15px;color:var(--gold2)}
#scBusy.on{display:flex}
#scBusy i{width:38px;height:38px;border-radius:50%;border:3px solid #ffffff22;border-top-color:var(--gold2);animation:scspin .8s linear infinite}
.scanv{width:100%;height:100%;overflow-y:auto;padding:12px 10px 30px;display:flex;flex-direction:column;align-items:center;gap:12px;-webkit-overflow-scrolling:touch}
.scanv img{max-width:100%;background:#fff;box-shadow:0 6px 20px #000a;border-radius:2px}
.cell .scb{position:absolute;left:6px;bottom:6px;background:#000b;color:#f3dc9a;font-size:11px;font-weight:700;padding:2px 7px;border-radius:9px}
/* ---- v2 : finitions ---- */
#scan{--sa:var(--acc,#e5b400);--ok2:#34d07a}
#scan .stop{gap:8px}
#scan .ttl{flex:1;text-align:center;line-height:1.15}
#scan .ttl h3{font-size:16px;color:#fff}
#scan .ttl small{display:block;font-size:11.5px;color:#ffffffa0;font-weight:500;margin-top:1px}
#scan .rb{width:40px;height:40px;background:#0007;box-shadow:inset 0 0 0 1px #ffffff1f;font-size:17px;-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);transition:background .2s,color .2s,transform .12s}
#scan .rb:active{transform:scale(.92)}
#scan .rb.pill{width:auto;padding:0 12px;border-radius:20px;font-size:12px;font-weight:800;letter-spacing:.06em;color:#ffffffb0}
#scan .rb.pill.on{background:var(--sa);color:#1d1503;box-shadow:0 4px 14px #0006}
#scGrid{position:absolute;inset:0;pointer-events:none}
#scGrid i{position:absolute;background:#ffffff38}
#scGrid i:nth-child(1){left:33.33%;top:0;bottom:0;width:1px}#scGrid i:nth-child(2){left:66.66%;top:0;bottom:0;width:1px}
#scGrid i:nth-child(3){top:33.33%;left:0;right:0;height:1px}#scGrid i:nth-child(4){top:66.66%;left:0;right:0;height:1px}
#scHint{top:calc(64px + env(safe-area-inset-top));padding:8px 16px;border-radius:20px;font-size:13.5px;font-weight:600;background:#000b;-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);box-shadow:0 6px 20px #0006;transition:background .25s,color .25s,transform .25s}
#scHint.ok{background:var(--sa);color:#1d1503}
#scHint.go{background:var(--ok2);color:#062b16}
#scHint.warn{background:#ff9f0ae6;color:#2a1700}
#scCam .sbot{padding-top:30px}
#scCam .modes{display:flex;gap:4px;overflow-x:auto;scrollbar-width:none;justify-content:center;margin:0 -22px 16px;padding:0 22px}
#scCam .modes::-webkit-scrollbar{display:none}
#scCam .modes button{flex:none;padding:7px 13px;border-radius:16px;font-size:13px;font-weight:700;letter-spacing:.02em;color:#ffffffa8;text-transform:uppercase;transition:color .2s,background .2s}
#scCam .modes button.on{color:var(--sa);background:#ffffff14}
#scShot{border:0;width:78px;height:78px}
#scShot:after{inset:8px;background:#fff;box-shadow:0 0 0 1px #0002}
#scShot.auto:after{background:#fff}
#scShot .pr{position:absolute;inset:0;width:100%;height:100%;transform:rotate(-90deg)}
#scShot .pr circle{fill:none;stroke:#fff;stroke-width:5}
#scShot.auto .pr circle{stroke:#ffffff70}
#scShot .ring{inset:0;border-width:5px}
#scShot.arm .ring{border-top-color:var(--sa)}
#scShot.go .ring{animation:none;border-color:var(--ok2)}
#scShot.go:after{background:var(--ok2)}
#scGal,#scPg{width:56px;height:56px;border-radius:16px;background:#0007;box-shadow:inset 0 0 0 1px #ffffff22;color:#fff}
#scCrop .chint{text-align:center;color:#ffffff90;font-size:12.5px;padding:2px 0 8px}
#scCropS path.dim{fill:#000a;fill-rule:evenodd}
#scCropS polygon{fill:none;stroke:var(--sa);stroke-width:2.5}
#scCropS circle.h{fill:#fff;stroke:var(--sa);stroke-width:3;filter:drop-shadow(0 1px 3px #000c)}
#scCropS rect.m{fill:#fff;stroke:var(--sa);stroke-width:2.5;filter:drop-shadow(0 1px 3px #000c)}
#scCropS .on{fill:var(--sa)}
#scan .tools{gap:2px;padding-top:8px}
#scan .tools button{min-width:0;flex:1;font-size:11px;font-weight:600;color:#d6d6dc;border-radius:12px;padding:6px 2px}
#scan .tools button:active{background:#ffffff10;opacity:1}
#scan .tools button b{font-size:21px;height:24px;display:grid;place-items:center}
#scRev .stop h3{color:#fff}
#scRev .sl .pgn{position:absolute;bottom:16px;left:50%;transform:translateX(-50%);background:#000b;color:#fff;font-size:12px;font-weight:700;padding:3px 10px;border-radius:12px;pointer-events:none}
#scRev .sl .fn{position:absolute;top:14px;left:50%;transform:translateX(-50%);background:#000b;color:var(--sa);font-size:11.5px;font-weight:700;padding:3px 10px;border-radius:12px;pointer-events:none}
#scRev .filt button i{border-radius:12px}
#scRev .thumbs button{border-radius:8px}
#scRev .thumbs button.on{box-shadow:0 0 0 2.5px var(--sa)}
#scCard{position:absolute;left:50%;bottom:calc(150px + env(safe-area-inset-bottom));transform:translateX(-50%);display:flex;gap:8px;z-index:3}
#scCard span{padding:5px 12px;border-radius:14px;font-size:12px;font-weight:700;background:#0009;color:#ffffffa0;box-shadow:inset 0 0 0 1px #ffffff22}
#scCard span.on{background:var(--sa);color:#1d1503}
#scCard span.ok{background:#34d07a33;color:#6fe3a2}
`;
const html = `
<div class="pane" id="scCam">
  <div class="vw"><video id="scV" playsinline muted autoplay></video><div id="scGrid" class="hide"><i></i><i></i><i></i><i></i></div><canvas id="scO"></canvas><div id="scNoCam" class="hide"><div style="font-size:46px">📷</div><div id="scNoTxt">Caméra indisponible.</div><button class="gb p" id="scRetry">Réessayer</button></div><div id="scFlash"></div></div>
  <div class="stop"><button class="rb" id="scX" aria-label="Fermer">✕</button><div class="ttl"><h3>Scanner</h3><small id="scSub"></small></div><button class="rb pill" id="scAutoB" aria-label="Déclenchement automatique">AUTO</button><button class="rb hide" id="scTorch" aria-label="Lampe">⚡</button><button class="rb" id="scOpt" aria-label="Options">⋯</button></div>
  <div id="scHint">Placez le document dans l’écran</div>
  <div id="scCard" class="hide"><span id="scCard1">① Recto</span><span id="scCard2">② Verso</span></div>
  <div class="sbot">
    <div class="modes" id="scModes"><button data-m="doc">Document</button><button data-m="carte">Carte</button><button data-m="livre">Livre</button><button data-m="tableau">Tableau</button><button data-m="photo">Photo</button></div>
    <div class="row"><button id="scGal" aria-label="Importer une photo"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/></svg></button><button id="scShot" class="auto" aria-label="Scanner"><svg class="pr" viewBox="0 0 100 100"><circle cx="50" cy="50" r="46"/></svg><span class="ring"></span></button><button id="scPg" aria-label="Voir les pages"><span style="opacity:.5;font-size:13px">0 page</span></button></div>
  </div>
</div>
<div class="pane hide" id="scCrop">
  <div class="stop"><button class="gb" id="scCropNo">Annuler</button><h3>Ajuster les bords</h3><button class="gb p" id="scCropOk">OK</button></div>
  <div class="stage" id="scCropSt"><canvas id="scCropC"></canvas><svg id="scCropS"></svg><canvas id="scLoupe" width="220" height="220"></canvas></div>
  <div class="chint">Glissez un coin ou le milieu d’un bord</div>
  <div class="tools"><button id="scCAuto"><b>✨</b>Bords auto</button><button id="scCFull"><b>⛶</b>Page entière</button><button id="scCInit"><b>↺</b>Revenir</button><button id="scCRot"><b>↻</b>Pivoter</button></div>
</div>
<div class="pane hide" id="scRev">
  <div class="stop"><button class="gb" id="scRevBack">‹ Caméra</button><h3 id="scRevT">1 page</h3><button class="gb p" id="scSave">Enregistrer</button></div>
  <div class="stage" id="scStrip"></div>
  <div class="filt" id="scFilt"></div>
  <div id="scAdj"><label><b>Luminosité</b><input type="range" min="-50" max="50" value="0" data-k="b"><em>0</em></label><label><b>Contraste</b><input type="range" min="-50" max="50" value="0" data-k="c"><em>0</em></label><label><b>Netteté</b><input type="range" min="0" max="100" value="50" data-k="s"><em>50</em></label><div class="ar"><button id="scAdjAll">Appliquer à toutes les pages</button><button id="scAdj0">Réinitialiser</button></div></div>
  <div class="thumbs" id="scThumbs"></div>
  <div class="tools"><button id="scTCrop"><b>⌗</b>Recadrer</button><button id="scTAdj"><b>🎚</b>Ajuster</button><button id="scTRot"><b>↻</b>Pivoter</button><button id="scTRe"><b>⟲</b>Reprendre</button><button id="scTL"><b>‹</b>Avant</button><button id="scTR"><b>›</b>Après</button><button id="scTDel" class="dg"><b>🗑</b>Supprimer</button></div>
</div>
<div id="scBusy"><i></i><span id="scBusyT">Traitement…</span></div>
<input type="file" id="scIn" accept="image/*" multiple hidden>`;
const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
const sec = document.createElement('section'); sec.id = 'scan'; sec.className = 'scr'; sec.innerHTML = html;
document.body.insertBefore(sec, document.getElementById('mod'));
const E = id => document.getElementById(id);
const pane = id => ['scCam', 'scCrop', 'scRev'].forEach(p => E(p).classList.toggle('hide', p !== id));
const busy = t => { E('scBusyT').textContent = t || ''; E('scBusy').classList.toggle('on', !!t); };
const tick = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));

/* ---------- État ---------- */
let DEST = 'vault';   // 'vault' : caché dans le coffre ; 'note' : bloc-notes, comme Adobe Scan
let QUAL = 'haute', PAGES = [], CUR = 0, FILT = 'auto', AUTO = true, stream = null, track = null, loop = null, torch = false;
let lastQ = null, stable = 0, cool = 0, need = null, open = false, cropIdx = -1, cropQ = null, cropSrc = null, cropNew = false;
const QUALS = { std: { cap: 2400, out: 2000, jq: .82 }, haute: { cap: 3400, out: 2800, jq: .9 }, max: { cap: 4400, out: 3800, jq: .94 } };
const Q = () => QUALS[QUAL] || QUALS.haute;
// v2 : mode de prise de vue, grille, son, vérification des bords, format de page du PDF
let MODE = 'doc', GRID = false, SOUND = true, VERIF = false, PSIZE = 'auto', CARD = null;
const MODES = { doc: 'Document', carte: 'Carte recto verso', livre: 'Livre · 2 pages', tableau: 'Tableau blanc', photo: 'Photo, sans recadrage' };
window.scanPrefsRelire = () => { try { const o = JSON.parse(localStorage.getItem('scanPrefs') || '{}'); FILT = o.f || 'auto'; AUTO = o.a !== false; QUAL = o.q || 'haute';
  MODE = MODES[o.m] ? o.m : 'doc'; GRID = !!o.g; SOUND = o.s !== false; VERIF = !!o.v; PSIZE = ['auto', 'a4', 'lettre'].includes(o.p) ? o.p : 'auto'; } catch (e) {} };
scanPrefsRelire();
const savePrefs = () => { try { const o = JSON.parse(localStorage.getItem('scanPrefs') || '{}'); Object.assign(o, { f: FILT, a: AUTO, q: QUAL, m: MODE, g: GRID, s: SOUND, v: VERIF, p: PSIZE }); localStorage.setItem('scanPrefs', JSON.stringify(o)); } catch (e) {} };
let actx = null;
const clic = () => {   // petit bruit d'obturateur (désactivable)
  if (!SOUND) return;
  try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); const n = actx.sampleRate * .06, b = actx.createBuffer(1, n, actx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3) * (i < n * .3 ? 1 : .5);
    const s = actx.createBufferSource(), g = actx.createGain(); g.gain.value = .35; s.buffer = b; s.connect(g); g.connect(actx.destination); s.start(); } catch (e) {}
};
const small = document.createElement('canvas'), sctx = small.getContext('2d', { willReadFrequently: true });

const mid = document.createElement('canvas'), mctx = mid.getContext('2d', { willReadFrequently: true });
function detectOn(src, sw, sh, live) {   // renvoie un quadrilatère en coordonnées de la source
  const W = 320, H = Math.max(8, Math.round(sh * W / sw)); small.width = W; small.height = H;
  sctx.drawImage(src, 0, 0, W, H);
  let q = SC.detect2(sctx.getImageData(0, 0, W, H).data, W, H);
  if (!q) return null;
  // affinage sur une image plus grande : les coins tombent exactement sur les bords de la feuille
  const RW = Math.min(sw, live ? 720 : 1400), RH = Math.max(8, Math.round(sh * RW / sw)); mid.width = RW; mid.height = RH;
  mctx.drawImage(src, 0, 0, RW, RH);
  try { const g = SC.blur(SC.gray(mctx.getImageData(0, 0, RW, RH).data, RW, RH), RW, RH, 1); q = SC.refine(g, RW, RH, q.map(p => [p[0] * RW / W, p[1] * RH / H])); }
  catch (e) { q = q.map(p => [p[0] * RW / W, p[1] * RH / H]); }
  const cx = q.reduce((a, p) => a + p[0], 0) / 4, cy = q.reduce((a, p) => a + p[1], 0) / 4;
  return q.map(p => [(p[0] + (cx - p[0]) * .004) * sw / RW, (p[1] + (cy - p[1]) * .004) * sh / RH]);
}
const inset = (w, h, k = .04) => [[w * k, h * k], [w * (1 - k), h * k], [w * (1 - k), h * (1 - k)], [w * k, h * (1 - k)]];

/* ---------- Caméra ---------- */
async function camStart() {
  E('scNoCam').classList.add('hide');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return noCam('Votre navigateur ne donne pas accès à la caméra.<br>Importez une photo avec 🖼.');
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false }); }
  catch (e) {
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }); }
    catch (e2) { return noCam(e2 && e2.name === 'NotAllowedError' ? 'Accès à la caméra refusé.<br>Autorisez-le dans les réglages du site, ou importez une photo avec 🖼.' : 'Caméra indisponible.<br>Importez une photo avec 🖼.'); }
  }
  if (!open) return camStop();
  const V = E('scV'); V.srcObject = stream; try { await V.play(); } catch (e) {}
  track = stream.getVideoTracks()[0];
  try { const c = track.getCapabilities ? track.getCapabilities() : {}; E('scTorch').classList.toggle('hide', !c.torch);
    if (c.focusMode && c.focusMode.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {}); } catch (e) {}
  clearInterval(loop); loop = setInterval(liveDetect, 200);
}
function noCam(t) { E('scNoTxt').innerHTML = t; E('scNoCam').classList.remove('hide'); hint('Importez une photo du document', false); }
function camStop() {
  clearInterval(loop); loop = null;
  if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; track = null; torch = false; E('scTorch').classList.remove('on');
  const V = E('scV'); V.srcObject = null; drawOverlay(null);
}
function hint(t, k) { const h = E('scHint'); if (h.textContent !== t) h.textContent = t; h.className = k === true ? 'ok' : (k || ''); }
function mapV() {   // vidéo → écran (object-fit: cover)
  const V = E('scV'), cw = V.clientWidth, ch = V.clientHeight, vw = V.videoWidth, vh = V.videoHeight, s = Math.max(cw / vw, ch / vh);
  return { s, ox: (cw - vw * s) / 2, oy: (ch - vh * s) / 2, cw, ch };
}
function drawOverlay(q) {
  const O = E('scO'), r = window.devicePixelRatio || 1, cw = O.clientWidth, ch = O.clientHeight;
  if (O.width !== cw * r || O.height !== ch * r) { O.width = cw * r; O.height = ch * r; }
  const c = O.getContext('2d'); c.setTransform(r, 0, 0, r, 0, 0); c.clearRect(0, 0, cw, ch);
  if (!q) return;
  const m = mapV(), P = q.map(p => [p[0] * m.s + m.ox, p[1] * m.s + m.oy]);
  const col = stable >= 2 ? '#34d07a' : accent();
  // assombrit tout ce qui n'est pas la feuille
  c.beginPath(); c.rect(0, 0, cw, ch); P.slice().reverse().forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])); c.closePath();
  c.fillStyle = '#0000006b'; c.fill();
  c.beginPath(); P.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])); c.closePath();
  c.fillStyle = col + '1f'; c.fill();
  c.lineWidth = 2; c.strokeStyle = col + 'aa'; c.stroke();
  // coins en équerre
  c.lineWidth = 5; c.lineCap = 'round'; c.strokeStyle = col; c.shadowColor = '#0009'; c.shadowBlur = 6;
  P.forEach((p, i) => { const a = P[(i + 3) % 4], b = P[(i + 1) % 4], L = 26;
    const da = Math.hypot(a[0] - p[0], a[1] - p[1]) || 1, db = Math.hypot(b[0] - p[0], b[1] - p[1]) || 1, ka = Math.min(L, da / 3) / da, kb = Math.min(L, db / 3) / db;
    c.beginPath(); c.moveTo(p[0] + (a[0] - p[0]) * ka, p[1] + (a[1] - p[1]) * ka); c.lineTo(p[0], p[1]); c.lineTo(p[0] + (b[0] - p[0]) * kb, p[1] + (b[1] - p[1]) * kb); c.stroke(); });
  c.shadowBlur = 0;
}
let lum = 128, lumN = 0;
const accent = () => { const v = getComputedStyle(E('scan')).getPropertyValue('--sa').trim(); return /^#[0-9a-f]{6}$/i.test(v) ? v : '#e5b400'; };
function ringProgress(k) {   // anneau du déclencheur : se remplit pendant que le document est stable
  const c = E('scShot').querySelector('.pr circle'), L = 289;
  c.style.strokeDasharray = L; c.style.strokeDashoffset = k == null ? 0 : L * (1 - Math.max(0, Math.min(1, k)));
  c.style.stroke = k == null ? '' : (k >= 1 ? '#34d07a' : accent());
}
let shooting = false;
function liveDetect() {
  const V = E('scV'); if (!open || !V.videoWidth || E('scCam').classList.contains('hide') || shooting) return;
  const vw = V.videoWidth, vh = V.videoHeight;
  if (MODE === 'photo') {   // photo libre : pas de détection, toute l'image est gardée
    drawOverlay(null); lastQ = null; stable = 0; ringProgress(null);
    hint('Mode photo : touchez le bouton', true); return;
  }
  let q = null; try { q = detectOn(V, vw, vh, true); } catch (e) {}
  // éclairage (image réduite déjà en mémoire)
  if (++lumN % 4 === 1) { try { const d = sctx.getImageData(0, 0, small.width, small.height).data; let s = 0, n = 0; for (let i = 0; i < d.length; i += 64) { s += d[i] * .3 + d[i + 1] * .59 + d[i + 2] * .11; n++; } lum = s / n; } catch (e) {} }
  const now = Date.now();
  if (q && lastQ) { const mv = Math.max(...q.map((p, i) => dist(p, lastQ[i]))) / vw; stable = mv < .025 ? stable + 1 : 0; } else stable = 0;
  // lissage pour un cadre qui ne tremble pas
  lastQ = q && lastQ ? q.map((p, i) => [lastQ[i][0] * .5 + p[0] * .5, lastQ[i][1] * .5 + p[1] * .5]) : q;
  drawOverlay(lastQ);
  // après un scan auto : attendre que la page change (ou que le document sorte du cadre) avant le suivant
  if (need && (!q || Math.max(...q.map((p, i) => dist(p, need[i]))) / vw > .12)) need = null;
  // conseils : trop loin, trop penché, trop sombre
  const area = q ? SC.area(q) / (vw * vh) : 0, petit = q && area < (MODE === 'carte' ? .05 : .12);
  const side = q ? [dist(q[0], q[1]), dist(q[1], q[2]), dist(q[2], q[3]), dist(q[3], q[0])] : null;
  const penche = side && Math.min(side[0] / side[2], side[2] / side[0], side[1] / side[3], side[3] / side[1]) < .66;
  const sombre = lum < 55;
  const pre = MODE === 'carte' ? (CARD ? 'Verso · ' : 'Recto · ') : '';
  const armed = AUTO && q && !need && !petit && stable >= 2 && now > cool;
  ringProgress(armed ? (stable - 1) / 5 : null);
  E('scShot').classList.toggle('go', !!armed && stable >= 6);
  if (need && AUTO) hint(MODE === 'carte' && CARD ? 'Retournez la carte : verso' : (PAGES.length + (PAGES.length > 1 ? ' pages' : ' page') + ' · placez la page suivante'), true);
  else if (sombre && !torch) hint(E('scTorch').classList.contains('hide') ? 'Trop sombre : ajoutez de la lumière' : 'Trop sombre : allumez la lampe ⚡', 'warn');
  else if (!q) hint(pre + (AUTO ? 'Recherche du document…' : 'Placez le document dans l’écran'), false);
  else if (petit) hint(pre + 'Rapprochez-vous', 'warn');
  else if (penche) hint(pre + 'Tenez le téléphone bien au-dessus', 'warn');
  else if (AUTO) hint(pre + (stable >= 2 ? 'Ne bougez plus…' : 'Document trouvé'), stable >= 2 ? 'go' : true);
  else hint(pre + 'Touchez le bouton pour scanner', true);
  if (armed && stable >= 6) { cool = now + 1500; stable = 0; need = q; capture(); }
}
function toCanvas(src, w, h, cap) {
  cap = cap || Q().cap; const k = Math.min(1, cap / Math.max(w, h)), c = document.createElement('canvas');
  c.width = Math.round(w * k); c.height = Math.round(h * k); const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, c.width, c.height); return c;
}
async function capture() {
  const V = E('scV'); if (!V.videoWidth || shooting) return;
  shooting = true;
  try { await capture1(V); } finally { shooting = false; ringProgress(null); E('scShot').classList.remove('go'); }
}
async function capture1(V) {
  const f = E('scFlash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
  navigator.vibrate && navigator.vibrate(30); clic();
  let src = null;
  // photo pleine résolution du capteur quand le téléphone le permet (bien plus nette qu'une image de la vidéo)
  if (QUAL !== 'std' && track && window.ImageCapture) {
    try { hint('Photo en haute qualité…', true);
      const ic = new ImageCapture(track), bl = await Promise.race([ic.takePhoto(torch ? {} : { fillLightMode: 'off' }).catch(() => ic.takePhoto()), new Promise((_, ko) => setTimeout(() => ko(new Error('lent')), 3500))]);
      const bm = await createImageBitmap(bl, { imageOrientation: 'from-image' });
      if (bm.width * bm.height > V.videoWidth * V.videoHeight * 1.2) src = toCanvas(bm, bm.width, bm.height);
      bm.close && bm.close();
    } catch (e) {}
  }
  if (!src) src = toCanvas(V, V.videoWidth, V.videoHeight);
  if (MODE === 'photo') { await addPage(src, [[0, 0], [src.width, 0], [src.width, src.height], [0, src.height]], false, { f: 'photo' }); hint('Photo ajoutée ✓', 'go'); return; }
  let q = null; try { q = detectOn(src, src.width, src.height); } catch (e) {}
  // photo et vidéo n'ont pas toujours le même format (4:3 contre 16:9 sur Samsung) : la vidéo est le centre
  // de la photo, à la même échelle sur le grand côté. On y reporte le cadre vu en direct.
  if (!q && lastQ) {
    const vw = V.videoWidth, vh = V.videoHeight, k = Math.max(src.width, src.height) / Math.max(vw, vh), ox = (src.width - vw * k) / 2, oy = (src.height - vh * k) / 2;
    q = lastQ.map(p => [Math.max(0, Math.min(src.width, p[0] * k + ox)), Math.max(0, Math.min(src.height, p[1] * k + oy))]);
    if (!SC.convex(SC.order(q) || [[0, 0], [0, 0], [0, 0], [0, 0]])) q = null;
  }
  if (MODE === 'carte') return carteFace(src, q);
  if (MODE === 'livre' && q) {   // livre ouvert : on coupe au milieu → page de gauche puis page de droite
    const m1 = [(q[0][0] + q[1][0]) / 2, (q[0][1] + q[1][1]) / 2], m2 = [(q[3][0] + q[2][0]) / 2, (q[3][1] + q[2][1]) / 2];
    await addPage(src, [q[0], m1, m2, q[3]], false, { hold: 1 }); const first = CUR; await addPage(src, [m1, q[1], q[2], m2], VERIF, { after: 1 });
    if (VERIF && E('scCrop').classList.contains('hide')) openCrop(first, true); return;
  }
  // aucun bord trouvé (ou vérification demandée) : on ouvre le recadrage au lieu de garder un cadre au hasard
  await addPage(src, q, !q || VERIF, MODE === 'tableau' ? { f: 'tableau' } : null);
}
let RETAKE = null, RETOOK = false;   // « Reprendre » : la nouvelle photo remplace la page choisie
async function addPage(src, q, wantCrop, extra) {
  extra = extra || {}; const { hold, after, ...more } = extra;
  const p = { src, q: q || inset(src.width, src.height), rot: 0, f: FILT, adj: {}, out: null, url: null, auto: !!q, ...more };
  if (RETAKE != null && PAGES[RETAKE]) { const o = PAGES[RETAKE]; if (o.url) URL.revokeObjectURL(o.url); PAGES[RETAKE] = p; CUR = RETAKE; RETAKE = null; RETOOK = true; }
  else if (after && PAGES.length) { PAGES.splice(CUR + 1, 0, p); CUR = CUR + 1; }
  else { PAGES.push(p); CUR = PAGES.length - 1; }
  await renderPage(p); drawPg();
  if (hold) return;
  if (RETOOK) { RETOOK = false; if (wantCrop) { revFrom = true; openCrop(CUR, true); } else openReview(CUR); return; }
  if (wantCrop) openCrop(CUR, true);
}
/* ---------- Carte (identité, banque, visite) : recto + verso sur une seule page A4 ---------- */
const CARTE_R = 85.6 / 53.98;
function carteDraw() {
  E('scCard').classList.toggle('hide', MODE !== 'carte');
  E('scCard1').className = CARD ? 'ok' : 'on'; E('scCard2').className = CARD ? 'on' : '';
  E('scCard1').textContent = CARD ? '✓ Recto' : '① Recto';
}
function faceCanvas(src, q) {   // une face redressée, au format carte
  const [W0, H0] = SC.outSize(q, 1400); let W = W0, H = H0; if (W < H) [W, H] = [H, W];
  H = Math.round(W / CARTE_R);
  const qq = W0 < H0 ? [q[3], q[0], q[1], q[2]] : q;   // carte tenue en hauteur : on la couche
  const sd = src.getContext('2d').getImageData(0, 0, src.width, src.height).data, px = SC.warp(sd, src.width, src.height, qq, W, H);
  const c = document.createElement('canvas'); c.width = W; c.height = H; c.getContext('2d').putImageData(new ImageData(px, W, H), 0, 0); return c;
}
async function carteFace(src, q) {
  if (!q) q = inset(src.width, src.height, .08);
  if (!CARD) { CARD = faceCanvas(src, q); carteDraw(); hint('Retournez la carte : verso', true); toast('Recto ✓ — scannez le verso', 1800); return; }
  const a = CARD, b = faceCanvas(src, q); CARD = null; carteDraw();
  const PW = 2480, PH = 3508, cw = Math.round(PW * .62), chh = Math.round(cw / CARTE_R), c = document.createElement('canvas'); c.width = PW; c.height = PH;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, PW, PH);
  const x0 = (PW - cw) / 2, gap = PH * .06, y0 = (PH - chh * 2 - gap) / 2;
  g.imageSmoothingQuality = 'high';
  // coins arrondis comme une vraie carte (rayon 3,18 mm sur 85,6 mm), ombre douce et fin liseré
  const R = cw * .037, arrondi = (x, y) => { g.beginPath(); if (g.roundRect) g.roundRect(x, y, cw, chh, R); else { g.moveTo(x + R, y); g.arcTo(x + cw, y, x + cw, y + chh, R); g.arcTo(x + cw, y + chh, x, y + chh, R); g.arcTo(x, y + chh, x, y, R); g.arcTo(x, y, x + cw, y, R); g.closePath(); } };
  [[a, y0], [b, y0 + chh + gap]].forEach(([img, y]) => {
    g.save(); arrondi(x0, y); g.shadowColor = '#00000038'; g.shadowBlur = cw * .025; g.shadowOffsetY = cw * .008; g.fillStyle = '#fff'; g.fill(); g.restore();
    g.save(); arrondi(x0, y); g.clip(); g.drawImage(img, x0, y, cw, chh); g.restore();
    g.save(); arrondi(x0, y); g.lineWidth = Math.max(2, cw * .0025); g.strokeStyle = '#00000026'; g.stroke(); g.restore();
  });
  await addPage(c, [[0, 0], [PW, 0], [PW, PH], [0, PH]], false, { carte: 1 });
  hint('Carte ajoutée ✓', 'go');
}
function drawPg() {
  const b = E('scPg'), n = PAGES.length, last = PAGES[n - 1];
  b.innerHTML = n ? `<img src="${last.url}" alt=""><b>${n}</b>` : '<span style="opacity:.5;font-size:13px">0 page</span>';
  if (n) { b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); }
}

/* ---------- Traitement d'une page ---------- */
async function renderPage(p) {
  const s = p.src, sd = s.getContext('2d').getImageData(0, 0, s.width, s.height).data;
  const [W, H] = SC.outSize(p.q, Q().out);
  const px = SC.warp(sd, s.width, s.height, p.q, W, H);
  p.txt = undefined;
  const mk = JSON.stringify(p.q) + p.rot; if (p.miniK !== mk) { p.mini = null; p.miniK = mk; }
  SC.filter(px, W, H, p.f, p.adj);
  const c = document.createElement('canvas'), r = p.rot & 3; c.width = r & 1 ? H : W; c.height = r & 1 ? W : H;
  const t = document.createElement('canvas'); t.width = W; t.height = H; t.getContext('2d').putImageData(new ImageData(px, W, H), 0, 0);
  const x = c.getContext('2d'); x.translate(c.width / 2, c.height / 2); x.rotate(r * Math.PI / 2); x.drawImage(t, -W / 2, -H / 2);
  p.out = c;
  if (p.url) URL.revokeObjectURL(p.url);
  p.url = URL.createObjectURL(await new Promise(ok => c.toBlob(ok, 'image/jpeg', .8)));
}

/* ---------- Recadrage (4 coins + loupe) ---------- */
let cv = null;   // vue : échelle et décalage de l'image dans la zone
function openCrop(i, isNew) {
  cropIdx = i; cropNew = !!isNew; const p = PAGES[i]; cropSrc = p.src; cropQ = p.q.map(a => a.slice()); cropInit = p.q.map(a => a.slice());
  clearInterval(loop); loop = null; pane('scCrop');
  requestAnimationFrame(layoutCrop);
}
function layoutCrop() {
  const stg = E('scCropSt'), W = stg.clientWidth, H = stg.clientHeight, s = cropSrc, pad = 26;
  const k = Math.min((W - pad * 2) / s.width, (H - pad * 2) / s.height), c = E('scCropC'), r = window.devicePixelRatio || 1;
  cv = { k, ox: (W - s.width * k) / 2, oy: (H - s.height * k) / 2 };
  c.style.left = cv.ox + 'px'; c.style.top = cv.oy + 'px'; c.style.width = s.width * k + 'px'; c.style.height = s.height * k + 'px';
  c.width = Math.round(s.width * k * r); c.height = Math.round(s.height * k * r); c.getContext('2d').drawImage(s, 0, 0, c.width, c.height);
  drawCrop();
}
function drawCrop() {
  const P = cropQ.map(p => [p[0] * cv.k + cv.ox, p[1] * cv.k + cv.oy]), stg = E('scCropSt'), W = stg.clientWidth, H = stg.clientHeight;
  const M = P.map((p, i) => { const q = P[(i + 1) % 4]; return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, Math.atan2(q[1] - p[1], q[0] - p[0]) * 180 / Math.PI]; });
  E('scCropS').innerHTML = `<path class="dim" d="M0 0H${W}V${H}H0Z M${P.map(p => p.join(' ')).join(' L')} Z"/><polygon points="${P.map(p => p.join(',')).join(' ')}"/>` +
    M.map((m, i) => `<rect class="m${cropDrag === 4 + i ? ' on' : ''}" x="${m[0] - 14}" y="${m[1] - 4}" width="28" height="8" rx="4" transform="rotate(${m[2]} ${m[0]} ${m[1]})"/>`).join('') +
    P.map((p, i) => `<circle class="h${cropDrag === i ? ' on' : ''}" cx="${p[0]}" cy="${p[1]}" r="${cropDrag === i ? 15 : 12}"/>`).join('');
}
let cropDrag = -1, cropInit = null;
(() => {
  const stg = E('scCropSt'), L = E('scLoupe'); let off = [0, 0], start = null;
  const loupe = (x, y) => {   // loupe : affichée à l'opposé du doigt
    const s = cropSrc, sx = x * cv.k + cv.ox; L.style.display = 'block';
    L.style.left = (sx < stg.clientWidth / 2 ? stg.clientWidth - 126 : 16) + 'px'; L.style.top = '16px';
    const c = L.getContext('2d'), R = 110 / (cv.k * 2.5); c.fillStyle = '#000'; c.fillRect(0, 0, 220, 220);
    c.drawImage(s, x - R / 2, y - R / 2, R, R, 0, 0, 220, 220);
    c.strokeStyle = accent(); c.lineWidth = 2; c.beginPath(); c.moveTo(110, 88); c.lineTo(110, 132); c.moveTo(88, 110); c.lineTo(132, 110); c.stroke();
  };
  stg.addEventListener('pointerdown', e => {
    if (!cv) return; const b = stg.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
    const P = cropQ.map(p => [p[0] * cv.k + cv.ox, p[1] * cv.k + cv.oy]);
    let bi = -1, bd = 44; P.forEach((p, i) => { const d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; bi = i; } });
    if (bi < 0) { bd = 34; P.forEach((p, i) => { const q = P[(i + 1) % 4], d = Math.hypot((p[0] + q[0]) / 2 - x, (p[1] + q[1]) / 2 - y); if (d < bd) { bd = d; bi = 4 + i; } }); }
    if (bi < 0) return; cropDrag = bi;
    if (bi < 4) off = [P[bi][0] - x, P[bi][1] - y];
    else start = { x, y, a: cropQ[bi - 4].slice(), b: cropQ[(bi - 3) % 4].slice() };
    navigator.vibrate && navigator.vibrate(8);
    stg.setPointerCapture(e.pointerId); move(e);
  });
  const clamp = (x, y) => [Math.max(0, Math.min(cropSrc.width, x)), Math.max(0, Math.min(cropSrc.height, y))];
  const move = e => {
    if (cropDrag < 0) return; const b = stg.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
    if (cropDrag < 4) { const p = clamp((x + off[0] - cv.ox) / cv.k, (y + off[1] - cv.oy) / cv.k); cropQ[cropDrag] = p; drawCrop(); loupe(p[0], p[1]); return; }
    // milieu d'un bord : tout le côté se déplace, perpendiculairement à lui-même
    const i = cropDrag - 4, j = (i + 1) % 4, A = start.a, B = start.b, L2 = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1, nx = -(B[1] - A[1]) / L2, ny = (B[0] - A[0]) / L2;
    const d = ((x - start.x) * nx + (y - start.y) * ny) / cv.k;
    cropQ[i] = clamp(A[0] + nx * d, A[1] + ny * d); cropQ[j] = clamp(B[0] + nx * d, B[1] + ny * d); drawCrop();
    loupe((cropQ[i][0] + cropQ[j][0]) / 2, (cropQ[i][1] + cropQ[j][1]) / 2);
  };
  stg.addEventListener('pointermove', move);
  const up = () => { cropDrag = -1; L.style.display = 'none'; if (cv) drawCrop(); };
  stg.addEventListener('pointerup', up); stg.addEventListener('pointercancel', up);
})();
E('scCInit').onclick = () => { if (cropInit) { cropQ = cropInit.map(a => a.slice()); drawCrop(); } };
E('scCAuto').onclick = () => { const q = detectOn(cropSrc, cropSrc.width, cropSrc.height); if (q) { cropQ = q; drawCrop(); } else toast('Bords introuvables : placez les coins à la main', 2600); };
E('scCFull').onclick = () => { const s = cropSrc; cropQ = [[0, 0], [s.width, 0], [s.width, s.height], [0, s.height]]; drawCrop(); };
E('scCRot').onclick = () => { const p = PAGES[cropIdx]; p.rot = (p.rot + 1) & 3; toast(['Orientation d’origine', 'Pivoté de 90°', 'Pivoté de 180°', 'Pivoté de 270°'][p.rot], 1200); };
E('scCropNo').onclick = () => { if (cropNew) { /* la page reste avec le cadre proposé */ } backFromCrop(); };
E('scCropOk').onclick = async () => {
  if (!SC.convex(SC.order(cropQ) || [[0, 0], [0, 0], [0, 0], [0, 0]])) return toast('Les coins se croisent : replacez-les', 2400);
  const p = PAGES[cropIdx]; p.q = SC.order(cropQ); busy('Redressement…'); await tick();
  try { await renderPage(p); } finally { busy(); }
  drawPg(); backFromCrop();
};
function backFromCrop() {
  if (revFrom) { openReview(cropIdx); return; }
  pane('scCam'); if (stream) { clearInterval(loop); loop = setInterval(liveDetect, 200); }
}

/* ---------- Révision des pages ---------- */
let revFrom = false;
function openReview(i = PAGES.length - 1) {
  RETAKE = null;
  if (!PAGES.length) return toast('Aucune page scannée', 1600);
  revFrom = true; clearInterval(loop); loop = null; pane('scRev'); CUR = Math.max(0, Math.min(PAGES.length - 1, i));
  drawRev(true);
}
function drawRev(jump) {
  E('scRevT').textContent = PAGES.length + (PAGES.length > 1 ? ' pages' : ' page');
  const s = E('scStrip');
  const FN = Object.fromEntries(SC.FILTRES);
  s.innerHTML = PAGES.map((p, i) => `<div class="sl" data-i="${i}"><img src="${p.url}" alt="Page ${i + 1}"><span class="fn">${FN[p.f] || ''}</span>${PAGES.length > 1 ? `<span class="pgn">${i + 1} / ${PAGES.length}</span>` : ''}</div>`).join('');
  E('scThumbs').innerHTML = PAGES.map((p, i) => `<button data-i="${i}" class="${i === CUR ? 'on' : ''}"><img src="${p.url}" alt=""><i>${i + 1}</i></button>`).join('') + '<button class="add" id="scAdd" aria-label="Ajouter une page">＋</button>';
  E('scThumbs').querySelectorAll('button[data-i]').forEach(b => b.onclick = () => goPage(+b.dataset.i));
  E('scAdd').onclick = () => { revFrom = false; pane('scCam'); if (stream) { clearInterval(loop); loop = setInterval(liveDetect, 200); } else camStart(); };
  drawFilt();
  E('scTL').style.display = E('scTR').style.display = PAGES.length > 1 ? '' : 'none';
  if (jump) requestAnimationFrame(() => { s.scrollLeft = CUR * s.clientWidth; });
}
function miniDe(p) {   // aperçus de chaque filtre pour la page courante
  if (p.mini) return p.mini;
  const s = p.src, sd = s.getContext('2d').getImageData(0, 0, s.width, s.height).data, [W, H] = SC.outSize(p.q, 150), base = SC.warp(sd, s.width, s.height, p.q, W, H);
  const r = p.rot & 3, c = document.createElement('canvas'), t = document.createElement('canvas'); t.width = W; t.height = H; c.width = r & 1 ? H : W; c.height = r & 1 ? W : H;
  p.mini = {};
  for (const [f] of SC.FILTRES) { const px = new Uint8ClampedArray(base); SC.filter(px, W, H, f); t.getContext('2d').putImageData(new ImageData(px, W, H), 0, 0);
    const x = c.getContext('2d'); x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, c.width, c.height); x.translate(c.width / 2, c.height / 2); x.rotate(r * Math.PI / 2); x.drawImage(t, -W / 2, -H / 2); p.mini[f] = c.toDataURL('image/jpeg', .7); }
  return p.mini;
}
let filtPour = [];
function drawFilt() {
  const p = PAGES[CUR], F = E('scFilt');
  if (p && (filtPour[0] !== p || filtPour[1] !== p.mini || filtPour[2] !== PAGES.length)) {
    const m = miniDe(p); filtPour = [p, m, PAGES.length];
    F.innerHTML = SC.FILTRES.map(([f, l]) => `<button data-f="${f}"><i><img src="${m[f]}" alt=""></i><span>${l}</span></button>`).join('') + (PAGES.length > 1 ? '<button data-f="*" class="all"><i>⧉</i><span>Toutes</span></button>' : '');
    F.querySelectorAll('button').forEach(b => b.onclick = () => choisirFiltre(b.dataset.f));
  }
  F.querySelectorAll('button').forEach(b => b.classList.toggle('on', !!p && b.dataset.f === p.f));
  const a = (p && p.adj) || {}; E('scAdj').querySelectorAll('input').forEach(i => { const v = a[i.dataset.k] == null ? (i.dataset.k === 's' ? 50 : 0) : a[i.dataset.k]; i.value = v; i.nextElementSibling.textContent = v; });
  E('scThumbs').querySelectorAll('button[data-i]').forEach(b => b.classList.toggle('on', +b.dataset.i === CUR)); }
function goPage(i) { CUR = i; const s = E('scStrip'); s.scrollTo({ left: i * s.clientWidth, behavior: 'smooth' }); drawFilt(); }
E('scStrip').addEventListener('scroll', () => { const s = E('scStrip'), i = Math.round(s.scrollLeft / Math.max(1, s.clientWidth)); if (i !== CUR && PAGES[i]) { CUR = i; drawFilt(); } }, { passive: true });
async function redo(p) { const sl = E('scStrip').querySelector(`.sl[data-i="${CUR}"]`); if (sl) sl.insertAdjacentHTML('beforeend', '<span class="wait">Traitement…</span>'); await tick(); await renderPage(p); drawRev(); E('scStrip').scrollLeft = CUR * E('scStrip').clientWidth; }
async function choisirFiltre(f) {
  const p = PAGES[CUR]; if (!p) return;
  if (f === '*') { busy('Filtre appliqué à toutes les pages…'); await tick(); try { for (const x of PAGES) if (x !== p || x.f !== p.f) { x.f = p.f; x.adj = { ...(p.adj || {}) }; await renderPage(x); }  drawRev(true); toast('« ' + SC.FILTRES.find(x => x[0] === p.f)[1] + ' » sur toutes les pages'); } finally { busy(); } return; }
  if (p.f === f) return; p.f = FILT = f; savePrefs(); E('scFilt').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.f === f)); busy('Application du filtre…'); await tick();
  try { await redo(p);  drawFilt(); } finally { busy(); }
}
E('scTAdj').onclick = () => { const on = E('scAdj').classList.toggle('on'); E('scTAdj').classList.toggle('on', on); };
let adjT = null;
E('scAdj').querySelectorAll('input').forEach(i => {
  i.oninput = () => { i.nextElementSibling.textContent = i.value; };
  i.onchange = () => { const p = PAGES[CUR]; if (!p) return; p.adj = { ...(p.adj || {}), [i.dataset.k]: +i.value }; clearTimeout(adjT); adjT = setTimeout(async () => { await redo(p);  drawFilt(); }, 60); };
});
E('scAdj0').onclick = async () => { const p = PAGES[CUR]; if (!p) return; p.adj = {}; busy('Réinitialisation…'); try { await redo(p);  drawFilt(); } finally { busy(); } };
E('scAdjAll').onclick = async () => { const p = PAGES[CUR]; if (!p) return; busy('Réglages appliqués à toutes les pages…'); await tick(); try { for (const x of PAGES) if (x !== p) { x.adj = { ...(p.adj || {}) }; await renderPage(x); }  drawRev(true); } finally { busy(); } };
E('scTRot').onclick = async () => { const p = PAGES[CUR]; if (!p) return; p.rot = (p.rot + 1) & 3; busy('Rotation…'); try { await redo(p); } finally { busy(); } };
E('scTCrop').onclick = () => PAGES[CUR] && openCrop(CUR);
E('scTRe').onclick = () => { if (!PAGES[CUR]) return; RETAKE = CUR; revFrom = false; need = null; pane('scCam'); hint(`Reprendre la page ${CUR + 1}`, true); if (stream) { clearInterval(loop); loop = setInterval(liveDetect, 200); } else camStart(); };
const swap = (a, b) => { [PAGES[a], PAGES[b]] = [PAGES[b], PAGES[a]]; CUR = b; drawRev(true); };
E('scTL').onclick = () => CUR > 0 && swap(CUR, CUR - 1);
E('scTR').onclick = () => CUR < PAGES.length - 1 && swap(CUR, CUR + 1);
E('scTDel').onclick = async () => {
  if (!PAGES[CUR]) return;
  if (!(await ask({ title: `Supprimer la page ${CUR + 1} ?`, ok: 'Supprimer', danger: true }))) return;
  const [p] = PAGES.splice(CUR, 1); if (p.url) URL.revokeObjectURL(p.url); drawPg();
  if (!PAGES.length) { revFrom = false; pane('scCam'); if (stream) { clearInterval(loop); loop = setInterval(liveDetect, 200); } else camStart(); return; }
  CUR = Math.min(CUR, PAGES.length - 1); drawRev(true);
};
E('scRevBack').onclick = () => { revFrom = false; pane('scCam'); if (stream) { clearInterval(loop); loop = setInterval(liveDetect, 200); } else camStart(); };

/* ---------- Enregistrement dans le coffre (chiffré) ---------- */
const jpg = c => new Promise(ok => c.toBlob(b => b.arrayBuffer().then(a => ok(new Uint8Array(a))), 'image/jpeg', Q().jq));
const thumbOf = c => drawThumb(c, c.width, c.height);
E('scSave').onclick = async () => {
  if (DEST === 'note') return saveNote();
  if (!PAGES.length || !KEY) return;
  const fmt = await sheet('Enregistrer le scan', [
    { v: 'pdf', ico: '📕', cls: 'r', label: 'PDF', sub: PAGES.length > 1 ? `Un seul fichier de ${PAGES.length} pages` : 'Un fichier PDF' },
    { v: 'jpg', ico: '🖼', cls: 'b', label: PAGES.length > 1 ? 'Photos' : 'Photo', sub: PAGES.length > 1 ? 'Une image par page' : 'Une image JPEG' }
  ]);
  if (!fmt) return;
  const sug = await titreDoc(); busy();
  let name = await ask({ title: 'Nom du document', input: sug, ok: 'Enregistrer' });
  if (name === null) return; name = (name || '').trim().replace(/[\\/:*?"<>|]/g, '-') || 'Scan ' + stamp();
  busy('Chiffrement dans le coffre…'); await tick();
  try {
    const now = Date.now();
    if (fmt === 'pdf') {
      const pg = []; for (const p of PAGES) pg.push({ jpg: await jpg(p.out), w: p.out.width, h: p.out.height });
      const bytes = SC.pdf(pg, PSIZE), id = newId();
      const meta = { name: /\.pdf$/i.test(name) ? name : name + '.pdf', type: 'application/pdf', size: bytes.length, kind: 'doc', thumb: thumbOf(PAGES[0].out), scan: PAGES.length, added: now, taken: now, album: ALBUM || '' };
      await storeItem(id, bytes.buffer, meta); ITEMS.push({ id, ...meta });
    } else {
      for (let i = 0; i < PAGES.length; i++) {
        const p = PAGES[i], b = await jpg(p.out), id = newId();
        const meta = { name: name + (PAGES.length > 1 ? ` (${i + 1})` : '') + '.jpg', type: 'image/jpeg', size: b.length, kind: 'photo', thumb: thumbOf(p.out), dur: 0, w: p.out.width, h: p.out.height, added: now + i, taken: now, album: ALBUM || '' };
        await storeItem(id, b.buffer, meta); ITEMS.push({ id, ...meta });
      }
    }
    ITEMS.sort((a, b) => b.added - a.added);
    const n = PAGES.length; scanClose(); render(); sync();
    toast(fmt === 'pdf' ? `Document scanné caché dans le coffre 🔐 (${n} page${n > 1 ? 's' : ''})` : `${n} page${n > 1 ? 's' : ''} cachée${n > 1 ? 's' : ''} dans le coffre 🔐`, 2800);
  } catch (e) { console.warn(e); busy(); toast('Impossible d’enregistrer : mémoire pleine ?', 3500); }
};

/* ---------- Bloc-notes : scan comme Adobe Scan (PDF à partager, texte reconnu, note) ---------- */
const pdfOf = async () => { const pg = []; for (const p of PAGES) pg.push({ jpg: await jpg(p.out), w: p.out.width, h: p.out.height }); return SC.pdf(pg, PSIZE); };
async function partager(bytes, name, type) {
  const f = new File([bytes], name, { type });
  try { if (navigator.canShare && navigator.canShare({ files: [f] })) { await navigator.share({ files: [f], title: name }); return true; } } catch (e) { if (e.name === 'AbortError') return true; }
  const u = URL.createObjectURL(f), a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 60000);
  return true;
}
async function lireTexte(force, seule) {
  if (!window.ocrPages || (!force && window.nPrefs && !window.nPrefs().ocr)) return '';
  const L = seule ? [PAGES[0]] : PAGES, aLire = L.filter(p => p.txt === undefined);
  if (aLire.length) {
    busy(seule ? 'Lecture du titre…' : 'Préparation de la lecture du texte…'); await tick();
    const t = await window.ocrPages(aLire.map(p => p.out), (i, n) => busy(i < 0 ? 'Préparation de la lecture du texte…' : seule ? 'Lecture du titre…' : `Lecture du texte… page ${i}/${n}`));
    aLire.forEach((p, i) => p.txt = t[i] || '');
  }
  return L.map((p, i) => (PAGES.length > 1 && p.txt ? `— Page ${i + 1} —\n` : '') + p.txt).filter(Boolean).join('\n\n');
}
// nom du scan : titre lu dans le document (réglage « Automatique »), sinon préfixe + date
const nomAuto = () => !window.nPrefs || window.nPrefs().nomAuto !== false;
const prefixe = () => (window.nPrefs && window.nPrefs().nomScan) || 'Scan';
// sans texte lisible : le genre de scan + la date en toutes lettres (« Carte du 26 novembre, 19h35 »)
const genreScan = () => PAGES.some(p => p.carte) ? 'carte' : '';
function nomSecours() {
  const d = new Date(), g = PAGES.some(p => p.carte) ? 'Carte' : PAGES.length && PAGES.every(p => p.f === 'tableau') ? 'Tableau blanc' : PAGES.length && PAGES.every(p => p.f === 'photo') ? 'Photo' : 'Document';
  return `${g} du ${d.getDate()} ${SC.MOISN[d.getMonth()]}, ${d.getHours()}h${String(d.getMinutes()).padStart(2, '0')}`;
}
async function titreDoc() {
  let ti = '';
  if (nomAuto()) { try { ti = SC.titre(await lireTexte(true, true), genreScan()); } catch (e) { console.warn(e); } return ti || nomSecours(); }
  return prefixe() + ' ' + stamp();
}
window.scanTitre = SC.titre;
window.scanPartager = partager;
const pageMini = c => { const W = 132, H = 168, m = document.createElement('canvas'); m.width = W; m.height = H; const g = m.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); const k = W / c.width; g.drawImage(c, 0, 0, W, c.height * k); return m.toDataURL('image/jpeg', .8); };   // haut de la 1re page, comme une vignette de document
// documents d'identité, de banque, de santé… : jamais en clair
const SENSIBLE = /Carte d’identité|Passeport|Permis de conduire|Titre de séjour|Carte grise|Carte bancaire|Carte de mutuelle|Fiche de paie|Relevé bancaire|Impôts?|SPF Finances|précompte|Certificat médical|Ordonnance|Contrat|Bail|Attestation|Assurance/i;
async function saveNote() {
  if (!PAGES.length) return;
  const n = PAGES.length, pl = n > 1 ? 's' : '';
  let sens = '';
  try { const ti = SC.titre(await lireTexte(true, true), genreScan()); if (SENSIBLE.test(ti)) sens = ti; } catch (e) {} busy();
  if (sens) {
    const c = await sheet('🔒 Document sensible : ' + sens, [
      { v: 'coffre', ico: '🔐', cls: 'g', label: 'Le cacher dans le coffre (conseillé)', sub: 'Chiffré et protégé par votre code. Il apparaîtra à la prochaine ouverture du coffre.' },
      { v: 'garder', ico: '📝', cls: 'gr', label: 'Le garder dans le bloc-notes', sub: 'Sans chiffrement. Aucune copie automatique sur le téléphone ni sur Drive.' }
    ]);
    if (!c) return;
    if (c === 'coffre') {
      if (!window.coffreDepot) return toast('Indisponible', 2000);
      busy('Chiffrement…'); await tick();
      try {
        const bytes = await pdfOf(), ok = await window.coffreDepot(bytes, { name: sens.replace(/[\\/:*?"<>|]/g, '-') + '.pdf', type: 'application/pdf', thumb: thumbOf(PAGES[0].out), scan: n, kind: 'doc' });
        busy();
        if (!ok) return toast('Ouvrez le coffre une première fois, puis recommencez', 3500);
        scanClose(true); toast('Caché dans le coffre 🔐 — visible à sa prochaine ouverture', 3500);
      } catch (e) { console.warn(e); busy(); toast('Impossible de chiffrer le document', 3000); }
      return;
    }
  }
  const v = await sheet('Que faire du scan ?', [
    { v: 'note', ico: '📝', cls: 'y', label: curNote ? 'Ajouter à cette note' : 'Créer une note', sub: 'PDF joint + texte reconnu, modifiable' },
    { v: 'pdf', ico: '📕', cls: 'r', label: 'Partager en PDF', sub: n > 1 ? `Un seul fichier de ${n} pages` : 'WhatsApp, e-mail, Drive…' },
    { v: 'txt', ico: '🔤', cls: 'g', label: 'Copier le texte', sub: 'Reconnaissance du texte (OCR)' },
    { v: 'jpg', ico: '🖼', cls: 'b', label: `Partager en photo${pl}`, sub: n > 1 ? 'Une image par page' : 'Une image JPEG' }
  ]);
  if (!v) return;
  try {
    if (v === 'pdf') {
      let name = nomAuto() ? await titreDoc() : await ask({ title: 'Nom du PDF', input: prefixe() + ' ' + stamp(), ok: 'Partager' }); busy(); if (name === null) return;
      name = (name || '').trim().replace(/[\\/:*?"<>|]/g, '-') || 'Scan ' + stamp();
      busy('Création du PDF…'); await tick(); const b = await pdfOf(); busy();
      await partager(b, /\.pdf$/i.test(name) ? name : name + '.pdf', 'application/pdf'); return;
    }
    if (v === 'jpg') {
      busy('Préparation…'); await tick();
      const files = []; for (let i = 0; i < n; i++) files.push(new File([await jpg(PAGES[i].out)], `${((PAGES[0].txt && nomAuto() && SC.titre(PAGES[0].txt, genreScan())) || (nomAuto() ? nomSecours() : prefixe() + ' ' + stamp())).replace(/[\\/:*?"<>|]/g, '-')}${n > 1 ? ` (${i + 1})` : ''}.jpg`, { type: 'image/jpeg' }));
      busy();
      try { if (navigator.canShare && navigator.canShare({ files })) { await navigator.share({ files }); return; } } catch (e) { if (e.name === 'AbortError') return; }
      for (const f of files) await partager(f, f.name, f.type); return;
    }
    if (v === 'txt') {
      const t = await lireTexte(); busy();
      if (!t) { toast('Aucun texte trouvé sur ce document', 2600); return; }
      try { await navigator.clipboard.writeText(t); toast('Texte copié ✓', 2200); } catch (e) { toast('Copie impossible', 2200); }
      return;
    }
    // note : PDF joint + texte reconnu
    let name = null;
    if (!nomAuto() && !curNote) { name = await ask({ title: 'Nom de la note', input: prefixe() + ' ' + stamp(), ok: 'Créer' }); if (name === null) return; }
    const drive = window.scanDrivePret ? window.scanDrivePret() : null;   // connexion Google demandée tout de suite (le toucher le permet)
    let texte = ''; try { texte = await lireTexte(); } catch (e) { console.warn(e); }
    let doc = '';   // titre du document lu dans le texte
    if (nomAuto()) { try { doc = SC.titre(texte || await lireTexte(true, true), genreScan()); } catch (e) {} }
    const secours = nomAuto() ? nomSecours() : prefixe() + ' ' + stamp();
    if (name === null) name = curNote ? (curNote.title || doc || secours) : (doc || secours);
    name = (name || '').trim() || secours;
    const pdfNom = curNote ? (doc || secours) : name;
    busy('Création du PDF…'); await tick();
    const bytes = await pdfOf(), id = 'ns' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    busy('Enregistrement…'); await tick();
    await mset('nscan:' + id, bytes.buffer);
    const pj = { id, name: (pdfNom.replace(/[\\/:*?"<>|]/g, '-')) + '.pdf', pages: n, size: bytes.length, thumb: pageMini(PAGES[0].out), at: Date.now() };
    let note = curNote;
    if (!note) { note = { id: 'n' + Date.now().toString(36), title: name, txt: '', upd: Date.now() }; NOTES.push(note); }
    note.scans = (note.scans || []).concat(pj);
    if (texte) note.txt = (note.txt ? note.txt.replace(/\s+$/, '') + '\n\n' : '') + texte;
    note.upd = Date.now(); await nSave();
    const nn = note; scanClose(true); busy(); noteEdit(nn);
    toast(`« ${pj.name.replace(/\.pdf$/, '')} » ajouté${texte ? ' avec son texte' : ''} ✓`, 3000);
    if (sens) toast('Document sensible : gardé ici seulement, pas copié sur le téléphone ni sur Drive', 3500);
    else if (window.scanExporter) window.scanExporter(bytes, pj, nn, drive);   // téléphone (PDF) + Google Drive, en arrière-plan
  } catch (e) { console.warn(e); busy(); toast('Impossible : mémoire pleine ?', 3000); }
}

/* ---------- Import depuis la galerie ---------- */
E('scGal').onclick = () => { const f = E('scIn'); f.value = ''; pickerOpen = true; setTimeout(() => pickerOpen = false, 90000); f.click(); };
E('scIn').onchange = async e => {
  pickerOpen = false; const files = [...e.target.files]; if (!files.length) return;
  busy('Analyse des pages…'); await tick();
  let firstNo = -1;
  try {
    for (const f of files) {
      const bm = await createImageBitmap(f, { imageOrientation: 'from-image' }).catch(() => null) || await new Promise((ok, ko) => { const u = URL.createObjectURL(f), im = new Image(); im.onload = () => ok(im); im.onerror = ko; im.src = u; });
      const w = bm.width || bm.naturalWidth, h = bm.height || bm.naturalHeight, src = toCanvas(bm, w, h);
      if (bm.close) bm.close();
      let q = null; try { q = detectOn(src, src.width, src.height); } catch (er) {}
      PAGES.push({ src, q: q || inset(src.width, src.height, 0), rot: 0, f: FILT, adj: {}, out: null, url: null, auto: !!q });
      if (!q && firstNo < 0) firstNo = PAGES.length - 1;
      await renderPage(PAGES[PAGES.length - 1]);
    }
  } catch (er) { toast('Image illisible', 2200); }
  busy(); drawPg();
  if (files.length === 1 && PAGES.length) openCrop(PAGES.length - 1, true); else openReview(firstNo >= 0 ? firstNo : PAGES.length - 1);
};

/* ---------- Boutons de la caméra ---------- */
E('scShot').onclick = () => { if (E('scV').videoWidth) { cool = Date.now() + 1500; need = lastQ; capture(); } else E('scGal').click(); };
E('scPg').onclick = () => openReview();
E('scRetry').onclick = camStart;
E('scTorch').onclick = async () => { if (!track) return; torch = !torch; try { await track.applyConstraints({ advanced: [{ torch }] }); E('scTorch').classList.toggle('on', torch); } catch (e) { torch = false; } };
E('scAutoB').onclick = () => { AUTO = !AUTO; savePrefs(); drawMode(); toast(AUTO ? 'Déclenchement automatique' : 'Déclenchement manuel', 1300); };
E('scModes').querySelectorAll('button').forEach(b => b.onclick = () => {
  if (MODE === b.dataset.m) return; MODE = b.dataset.m; CARD = null; stable = 0; lastQ = null; need = null; savePrefs(); drawMode();
  b.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  toast({ doc: 'Document : bords trouvés tout seuls', carte: 'Carte : recto puis verso, sur une seule page', livre: 'Livre : 2 pages ouvertes → 2 pages', tableau: 'Tableau blanc : reflets effacés', photo: 'Photo : image entière, sans recadrage' }[MODE], 1800);
});
function drawMode() {
  E('scAutoB').classList.toggle('on', AUTO); E('scAutoB').classList.toggle('hide', MODE === 'photo'); E('scShot').classList.toggle('auto', AUTO && MODE !== 'photo');
  E('scModes').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.m === MODE));
  E('scGrid').classList.toggle('hide', !GRID);
  E('scSub').textContent = MODES[MODE] + ' · ' + (DEST === 'note' ? 'Bloc-notes' : 'Coffre 🔐');
  carteDraw();
}
// options rapides, sans quitter la caméra
E('scOpt').onclick = async () => {
  const ck = b => b ? '  ✓' : '', FN = Object.fromEntries(SC.FILTRES);
  const v = await sheet('Options du scanner', [
    { v: 'q', ico: '💎', cls: 'p', label: 'Qualité : ' + { std: 'Standard', haute: 'Haute', max: 'Maximale' }[QUAL], sub: 'Standard → Haute → Maximale' },
    { v: 'f', ico: '🎨', cls: 'o', label: 'Filtre de départ : ' + (FN[FILT] || 'Auto couleur'), sub: 'Appliqué à chaque nouvelle page' },
    { v: 'p', ico: '📐', cls: 'b', label: 'Format du PDF : ' + { auto: 'Taille de la page', a4: 'A4', lettre: 'Lettre US' }[PSIZE], sub: 'Taille de la page → A4 → Lettre' },
    { v: 'v', ico: '🔍', cls: 'g', label: 'Vérifier les bords après chaque photo' + ck(VERIF), sub: 'Ouvre l’écran des coins à chaque scan' },
    { v: 'g', ico: '▦', cls: 'gr', label: 'Grille d’aide' + ck(GRID), sub: 'Pour bien aligner le document' },
    { v: 's', ico: '🔊', cls: 'y', label: 'Son de l’obturateur' + ck(SOUND), sub: 'Petit clic à chaque photo' }
  ]);
  if (!v) return;
  if (v === 'q') QUAL = { std: 'haute', haute: 'max', max: 'std' }[QUAL];
  if (v === 'f') { const ks = SC.FILTRES.map(x => x[0]); FILT = ks[(ks.indexOf(FILT) + 1) % ks.length]; }
  if (v === 'p') PSIZE = { auto: 'a4', a4: 'lettre', lettre: 'auto' }[PSIZE];
  if (v === 'v') VERIF = !VERIF; if (v === 'g') GRID = !GRID; if (v === 's') { SOUND = !SOUND; clic(); }
  savePrefs(); drawMode(); E('scOpt').onclick();   // la liste se rouvre pour enchaîner les réglages
};
E('scX').onclick = async () => {
  if (PAGES.length && !(await ask({ title: 'Abandonner le scan ?', text: `${PAGES.length} page${PAGES.length > 1 ? 's' : ''} non enregistrée${PAGES.length > 1 ? 's' : ''} seront perdues.`, ok: 'Abandonner', danger: true }))) return;
  scanClose();
};

/* ---------- Ouverture / fermeture ---------- */
window.scanOpen = (dest) => {
  DEST = dest === 'note' ? 'note' : 'vault';
  if (DEST === 'vault' && !KEY) return; open = true; PAGES = []; CUR = 0; lastQ = null; need = null; stable = 0; cool = 0; revFrom = false; CARD = null; RETAKE = null; scanPrefsRelire();
  drawPg(); drawMode(); pane('scCam'); hint('Placez le document dans l’écran', false); show('scan'); camStart();
};
function scanClose(silent) {
  open = false; camStop(); busy();
  PAGES.forEach(p => p.url && URL.revokeObjectURL(p.url)); PAGES = [];
  if (!silent) show(DEST === 'note' ? (curNote ? 'nedit' : 'notes') : 'vault');
}
window.scanClose = scanClose;
// Le coffre se verrouille : on coupe la caméra et on efface les pages en mémoire
const _lock = lockNow;
lockNow = function () { if (open) scanClose(true); return _lock.apply(this, arguments); };
document.addEventListener('visibilitychange', () => { if (!open) return; if (document.hidden) { clearInterval(loop); loop = null; } else if (stream && !E('scCam').classList.contains('hide')) { clearInterval(loop); loop = setInterval(liveDetect, 200); } });
window.addEventListener('resize', () => { if (open && !E('scCrop').classList.contains('hide') && cropSrc) layoutCrop(); });

/* ---------- Affichage des PDF scannés dans la visionneuse (sans lecteur PDF) ---------- */
window.scanView = async (it, blob, vc) => {
  const imgs = SC.pdfImages(await blob.arrayBuffer());
  if (!imgs.length) return false;
  const urls = imgs.map(b => { const u = URL.createObjectURL(new Blob([b], { type: 'image/jpeg' })); URLS.push(u); return u; });
  vc.innerHTML = `<div class="scanv">${urls.map((u, i) => `<img src="${u}" alt="Page ${i + 1}" loading="lazy">`).join('')}</div>`;
  return true;
};
})();
