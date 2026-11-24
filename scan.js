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
// Filtres : 'auto' (couleur améliorée), 'bw' (noir & blanc), 'gray', 'orig'
SC.filter = (d, w, h, mode) => {
  if (mode === 'orig') return;
  // carte d'éclairage : maximum local par bloc, élargi puis lissé → fond blanc uniforme, ombres effacées
  const S = Math.max(8, Math.round(Math.max(w, h) / 90)), bw = Math.ceil(w / S), bh = Math.ceil(h / S);
  let m = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let mx = 0; const y1 = Math.min(h, (by + 1) * S), x1 = Math.min(w, (bx + 1) * S);
    for (let y = by * S; y < y1; y += 2) for (let x = bx * S; x < x1; x += 2) { const i = (y * w + x) * 4, l = d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114; if (l > mx) mx = l; }
    m[by * bw + bx] = mx;
  }
  for (let it = 0; it < 2; it++) { const o = new Float32Array(m.length);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { let mx = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = y + dy, xx = x + dx; if (yy >= 0 && yy < bh && xx >= 0 && xx < bw && m[yy * bw + xx] > mx) mx = m[yy * bw + xx]; } o[y * bw + x] = mx; }
    m = o; }
  m = SC.blur(m, bw, bh, 2);
  const ill = (x, y) => { const fx = Math.max(0, Math.min(bw - 1.001, x / S - .5)), fy = Math.max(0, Math.min(bh - 1.001, y / S - .5)), x0 = fx | 0, y0 = fy | 0, ax = fx - x0, ay = fy - y0, x1 = Math.min(bw - 1, x0 + 1), y1 = Math.min(bh - 1, y0 + 1);
    return (m[y0 * bw + x0] * (1 - ax) + m[y0 * bw + x1] * ax) * (1 - ay) + (m[y1 * bw + x0] * (1 - ax) + m[y1 * bw + x1] * ax) * ay; };
  const cl = v => v < 0 ? 0 : v > 255 ? 255 : v;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, k = 255 / Math.max(48, ill(x, y));
    let r = d[i] * k, g = d[i + 1] * k, b = d[i + 2] * k;
    if (mode === 'auto') {
      const l = r * .299 + g * .587 + b * .114, sat = 1.25;
      r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat;
      const c = v => { v = (v - 28) * 1.13; return v > 236 ? 255 : v; };   // noirs plus noirs, papier bien blanc
      d[i] = cl(c(r)); d[i + 1] = cl(c(g)); d[i + 2] = cl(c(b));
    } else {
      let l = r * .299 + g * .587 + b * .114;
      if (mode === 'bw') { const t = Math.max(0, Math.min(1, (l - 120) / 85)); l = 255 * t * t * (3 - 2 * t); }
      else { l = (l - 22) * 1.12; if (l > 238) l = 255; }
      d[i] = d[i + 1] = d[i + 2] = cl(l);
    }
  }
};

/* ---------- PDF (sans bibliothèque) : une image JPEG par page ---------- */
SC.pdf = pages => {   // pages : [{ jpg: Uint8Array, w, h }]
  const te = s => new TextEncoder().encode(s), parts = [], offs = []; let len = 0;
  const add = b => { if (typeof b === 'string') b = te(b); parts.push(b); len += b.length; };
  const obj = (n, body) => { offs[n] = len; add(`${n} 0 obj\n`); body(); add('\nendobj\n'); };
  add('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'.replace(/[\u0080-ÿ]/g, '*'));
  const n = pages.length, kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  obj(1, () => add('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => add(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`));
  pages.forEach((p, i) => {
    const pn = 3 + i * 3, cn = pn + 1, im = pn + 2;
    const PW = 595.28, PH = +(PW * p.h / p.w).toFixed(2);   // largeur A4, hauteur selon la page
    const cs = `q ${PW} 0 0 ${PH} 0 0 cm /Im0 Do Q`;
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
#scRev .filt{display:flex;gap:8px;overflow-x:auto;padding:8px 14px;scrollbar-width:none}
#scRev .filt button{flex:0 0 auto;padding:7px 13px;border-radius:16px;background:#ffffff12;font-size:13px;font-weight:600;color:#ddd}
#scRev .filt button.on{background:#d9b25a33;color:var(--gold2);box-shadow:inset 0 0 0 1px #d9b25a88}
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
`;
const html = `
<div class="pane" id="scCam">
  <div class="vw"><video id="scV" playsinline muted autoplay></video><canvas id="scO"></canvas><div id="scNoCam" class="hide"><div style="font-size:46px">📷</div><div id="scNoTxt">Caméra indisponible.</div><button class="gb p" id="scRetry">Réessayer</button></div><div id="scFlash"></div></div>
  <div class="stop"><button class="rb" id="scX" aria-label="Fermer">✕</button><h3>Scanner</h3><button class="rb hide" id="scTorch" aria-label="Lampe">⚡</button></div>
  <div id="scHint">Placez le document dans l’écran</div>
  <div class="sbot">
    <div class="mode"><button data-a="1" class="on">Auto</button><button data-a="0">Manuel</button></div>
    <div class="row"><button id="scGal" aria-label="Importer une photo">🖼</button><button id="scShot" class="auto" aria-label="Scanner"><span class="ring"></span></button><button id="scPg" aria-label="Voir les pages"><span style="opacity:.5;font-size:13px">0 page</span></button></div>
  </div>
</div>
<div class="pane hide" id="scCrop">
  <div class="stop"><button class="gb" id="scCropNo">Annuler</button><h3>Ajuster les bords</h3><button class="gb p" id="scCropOk">OK</button></div>
  <div class="stage" id="scCropSt"><canvas id="scCropC"></canvas><svg id="scCropS"></svg><canvas id="scLoupe" width="220" height="220"></canvas></div>
  <div class="tools"><button id="scCAuto"><b>✨</b>Bords auto</button><button id="scCFull"><b>⛶</b>Page entière</button><button id="scCRot"><b>↻</b>Pivoter</button></div>
</div>
<div class="pane hide" id="scRev">
  <div class="stop"><button class="gb" id="scRevBack">‹ Caméra</button><h3 id="scRevT">1 page</h3><button class="gb p" id="scSave">Enregistrer</button></div>
  <div class="stage" id="scStrip"></div>
  <div class="filt" id="scFilt"><button data-f="auto">✨ Auto couleur</button><button data-f="bw">Noir & blanc</button><button data-f="gray">Gris</button><button data-f="orig">Original</button></div>
  <div class="thumbs" id="scThumbs"></div>
  <div class="tools"><button id="scTCrop"><b>⌗</b>Recadrer</button><button id="scTRot"><b>↻</b>Pivoter</button><button id="scTL"><b>‹</b>Avant</button><button id="scTR"><b>›</b>Après</button><button id="scTDel" class="dg"><b>🗑</b>Supprimer</button></div>
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
let PAGES = [], CUR = 0, FILT = 'auto', AUTO = true, stream = null, track = null, loop = null, torch = false;
let lastQ = null, stable = 0, cool = 0, need = null, open = false, cropIdx = -1, cropQ = null, cropSrc = null, cropNew = false;
try { const s = localStorage.getItem('scanPrefs'); if (s) { const o = JSON.parse(s); FILT = o.f || FILT; AUTO = o.a !== false; } } catch (e) {}
const savePrefs = () => { try { localStorage.setItem('scanPrefs', JSON.stringify({ f: FILT, a: AUTO })); } catch (e) {} };
const small = document.createElement('canvas'), sctx = small.getContext('2d', { willReadFrequently: true });

function detectOn(src, sw, sh) {   // renvoie un quadrilatère en coordonnées de la source
  const W = 240, H = Math.max(8, Math.round(sh * W / sw)); small.width = W; small.height = H;
  sctx.drawImage(src, 0, 0, W, H);
  const q = SC.detect(sctx.getImageData(0, 0, W, H).data, W, H);
  if (!q) return null;
  const cx = q.reduce((a, p) => a + p[0], 0) / 4, cy = q.reduce((a, p) => a + p[1], 0) / 4;
  return q.map(p => [(p[0] + (cx - p[0]) * .012) * sw / W, (p[1] + (cy - p[1]) * .012) * sh / H]);
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
function hint(t, ok) { const h = E('scHint'); h.textContent = t; h.classList.toggle('ok', !!ok); }
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
  c.beginPath(); P.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])); c.closePath();
  c.fillStyle = stable > 2 ? '#d9b25a40' : '#d9b25a22'; c.fill();
  c.lineWidth = 3; c.strokeStyle = '#f3dc9a'; c.shadowColor = '#000'; c.shadowBlur = 6; c.stroke(); c.shadowBlur = 0;
  P.forEach(p => { c.beginPath(); c.arc(p[0], p[1], 7, 0, 7); c.fillStyle = '#f3dc9a'; c.fill(); });
}
function liveDetect() {
  const V = E('scV'); if (!open || !V.videoWidth || E('scCam').classList.contains('hide')) return;
  let q = null; try { q = detectOn(V, V.videoWidth, V.videoHeight); } catch (e) {}
  const now = Date.now();
  if (q && lastQ) { const mv = Math.max(...q.map((p, i) => dist(p, lastQ[i]))) / V.videoWidth; stable = mv < .025 ? stable + 1 : 0; } else stable = 0;
  // lissage pour un cadre qui ne tremble pas
  lastQ = q && lastQ ? q.map((p, i) => [lastQ[i][0] * .5 + p[0] * .5, lastQ[i][1] * .5 + p[1] * .5]) : q;
  drawOverlay(lastQ);
  // après un scan auto : attendre que la page change (ou que le document sorte du cadre) avant le suivant
  if (need && (!q || Math.max(...q.map((p, i) => dist(p, need[i]))) / V.videoWidth > .12)) need = null;
  const armed = AUTO && q && !need && stable >= 2 && now > cool;
  E('scShot').classList.toggle('arm', !!armed);
  if (need && AUTO) hint(PAGES.length + (PAGES.length > 1 ? ' pages' : ' page') + ' · placez la page suivante', true);
  else if (!q) hint(AUTO ? 'Recherche du document…' : 'Placez le document dans l’écran', false);
  else if (AUTO) hint(stable >= 2 ? 'Ne bougez plus…' : 'Document trouvé', true);
  else hint('Touchez le bouton pour scanner', true);
  if (armed && stable >= 6) { cool = now + 1500; stable = 0; need = q; capture(); }
}
function toCanvas(src, w, h, cap = 3200) {
  const k = Math.min(1, cap / Math.max(w, h)), c = document.createElement('canvas');
  c.width = Math.round(w * k); c.height = Math.round(h * k); c.getContext('2d').drawImage(src, 0, 0, c.width, c.height); return c;
}
async function capture() {
  const V = E('scV'); if (!V.videoWidth) return;
  const f = E('scFlash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
  navigator.vibrate && navigator.vibrate(30);
  const src = toCanvas(V, V.videoWidth, V.videoHeight);
  let q = null; try { q = detectOn(src, src.width, src.height); } catch (e) {}
  if (!q && lastQ) { const k = src.width / V.videoWidth; q = lastQ.map(p => [p[0] * k, p[1] * k]); }
  await addPage(src, q, !AUTO && !q);
}
async function addPage(src, q, wantCrop) {
  const p = { src, q: q || inset(src.width, src.height), rot: 0, f: FILT, out: null, url: null, auto: !!q };
  PAGES.push(p); CUR = PAGES.length - 1;
  await renderPage(p); drawPg();
  if (wantCrop) openCrop(CUR, true);
}
function drawPg() {
  const b = E('scPg'), n = PAGES.length, last = PAGES[n - 1];
  b.innerHTML = n ? `<img src="${last.url}" alt=""><b>${n}</b>` : '<span style="opacity:.5;font-size:13px">0 page</span>';
  if (n) { b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); }
}

/* ---------- Traitement d'une page ---------- */
async function renderPage(p) {
  const s = p.src, sd = s.getContext('2d').getImageData(0, 0, s.width, s.height).data;
  const [W, H] = SC.outSize(p.q);
  const px = SC.warp(sd, s.width, s.height, p.q, W, H);
  SC.filter(px, W, H, p.f);
  const c = document.createElement('canvas'), r = p.rot & 3; c.width = r & 1 ? H : W; c.height = r & 1 ? W : H;
  const t = document.createElement('canvas'); t.width = W; t.height = H; t.getContext('2d').putImageData(new ImageData(px, W, H), 0, 0);
  const x = c.getContext('2d'); x.translate(c.width / 2, c.height / 2); x.rotate(r * Math.PI / 2); x.drawImage(t, -W / 2, -H / 2);
  p.out = c;
  if (p.url) URL.revokeObjectURL(p.url);
  p.url = URL.createObjectURL(await new Promise(ok => c.toBlob(ok, 'image/jpeg', .85)));
}

/* ---------- Recadrage (4 coins + loupe) ---------- */
let cv = null;   // vue : échelle et décalage de l'image dans la zone
function openCrop(i, isNew) {
  cropIdx = i; cropNew = !!isNew; const p = PAGES[i]; cropSrc = p.src; cropQ = p.q.map(a => a.slice());
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
  const P = cropQ.map(p => [p[0] * cv.k + cv.ox, p[1] * cv.k + cv.oy]);
  E('scCropS').innerHTML = `<polygon points="${P.map(p => p.join(',')).join(' ')}"/>` + P.map((p, i) => `<circle class="h" cx="${p[0]}" cy="${p[1]}" r="13"/><circle class="t" data-i="${i}" cx="${p[0]}" cy="${p[1]}" r="30"/>`).join('');
}
(() => {
  const stg = E('scCropSt'), L = E('scLoupe'); let drag = -1, off = [0, 0];
  stg.addEventListener('pointerdown', e => {
    if (!cv) return; const b = stg.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
    let bi = -1, bd = 46; cropQ.forEach((p, i) => { const d = Math.hypot(p[0] * cv.k + cv.ox - x, p[1] * cv.k + cv.oy - y); if (d < bd) { bd = d; bi = i; } });
    if (bi < 0) return; drag = bi; off = [cropQ[bi][0] * cv.k + cv.ox - x, cropQ[bi][1] * cv.k + cv.oy - y];
    stg.setPointerCapture(e.pointerId); move(e);
  });
  const move = e => {
    if (drag < 0) return; const b = stg.getBoundingClientRect(), s = cropSrc;
    const x = Math.max(0, Math.min(s.width, (e.clientX - b.left + off[0] - cv.ox) / cv.k)), y = Math.max(0, Math.min(s.height, (e.clientY - b.top + off[1] - cv.oy) / cv.k));
    cropQ[drag] = [x, y]; drawCrop();
    // loupe : affichée à l'opposé du doigt
    const sx = x * cv.k + cv.ox, sy = y * cv.k + cv.oy; L.style.display = 'block';
    L.style.left = (sx < stg.clientWidth / 2 ? stg.clientWidth - 126 : 16) + 'px'; L.style.top = '16px';
    const c = L.getContext('2d'), R = 110 / (cv.k * 2.5); c.fillStyle = '#000'; c.fillRect(0, 0, 220, 220);
    c.drawImage(s, x - R / 2, y - R / 2, R, R, 0, 0, 220, 220);
    c.strokeStyle = '#f3dc9a'; c.lineWidth = 2; c.beginPath(); c.moveTo(110, 90); c.lineTo(110, 130); c.moveTo(90, 110); c.lineTo(130, 110); c.stroke();
  };
  stg.addEventListener('pointermove', move);
  const up = () => { drag = -1; L.style.display = 'none'; };
  stg.addEventListener('pointerup', up); stg.addEventListener('pointercancel', up);
})();
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
  if (!PAGES.length) return toast('Aucune page scannée', 1600);
  revFrom = true; clearInterval(loop); loop = null; pane('scRev'); CUR = Math.max(0, Math.min(PAGES.length - 1, i));
  drawRev(true);
}
function drawRev(jump) {
  E('scRevT').textContent = PAGES.length + (PAGES.length > 1 ? ' pages' : ' page');
  const s = E('scStrip');
  s.innerHTML = PAGES.map((p, i) => `<div class="sl" data-i="${i}"><img src="${p.url}" alt="Page ${i + 1}"></div>`).join('');
  E('scThumbs').innerHTML = PAGES.map((p, i) => `<button data-i="${i}" class="${i === CUR ? 'on' : ''}"><img src="${p.url}" alt=""><i>${i + 1}</i></button>`).join('') + '<button class="add" id="scAdd" aria-label="Ajouter une page">＋</button>';
  E('scThumbs').querySelectorAll('button[data-i]').forEach(b => b.onclick = () => goPage(+b.dataset.i));
  E('scAdd').onclick = () => { revFrom = false; pane('scCam'); if (stream) { clearInterval(loop); loop = setInterval(liveDetect, 200); } else camStart(); };
  drawFilt();
  E('scTL').style.visibility = E('scTR').style.visibility = PAGES.length > 1 ? 'visible' : 'hidden';
  if (jump) requestAnimationFrame(() => { s.scrollLeft = CUR * s.clientWidth; });
}
function drawFilt() { E('scFilt').querySelectorAll('button').forEach(b => b.classList.toggle('on', PAGES[CUR] && b.dataset.f === PAGES[CUR].f)); E('scThumbs').querySelectorAll('button[data-i]').forEach(b => b.classList.toggle('on', +b.dataset.i === CUR)); }
function goPage(i) { CUR = i; const s = E('scStrip'); s.scrollTo({ left: i * s.clientWidth, behavior: 'smooth' }); drawFilt(); }
E('scStrip').addEventListener('scroll', () => { const s = E('scStrip'), i = Math.round(s.scrollLeft / Math.max(1, s.clientWidth)); if (i !== CUR && PAGES[i]) { CUR = i; drawFilt(); } }, { passive: true });
async function redo(p) { const sl = E('scStrip').querySelector(`.sl[data-i="${CUR}"]`); if (sl) sl.insertAdjacentHTML('beforeend', '<span class="wait">Traitement…</span>'); await tick(); await renderPage(p); drawRev(); E('scStrip').scrollLeft = CUR * E('scStrip').clientWidth; }
E('scFilt').querySelectorAll('button').forEach(b => b.onclick = async () => {
  const p = PAGES[CUR]; if (!p || p.f === b.dataset.f) return; p.f = FILT = b.dataset.f; savePrefs(); drawFilt(); busy('Application du filtre…'); await tick();
  try { await redo(p); } finally { busy(); }
});
E('scTRot').onclick = async () => { const p = PAGES[CUR]; if (!p) return; p.rot = (p.rot + 1) & 3; busy('Rotation…'); try { await redo(p); } finally { busy(); } };
E('scTCrop').onclick = () => PAGES[CUR] && openCrop(CUR);
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
const jpg = c => new Promise(ok => c.toBlob(b => b.arrayBuffer().then(a => ok(new Uint8Array(a))), 'image/jpeg', .85));
const thumbOf = c => drawThumb(c, c.width, c.height);
E('scSave').onclick = async () => {
  if (!PAGES.length || !KEY) return;
  const fmt = await sheet('Enregistrer le scan', [
    { v: 'pdf', ico: '📕', cls: 'r', label: 'PDF', sub: PAGES.length > 1 ? `Un seul fichier de ${PAGES.length} pages` : 'Un fichier PDF' },
    { v: 'jpg', ico: '🖼', cls: 'b', label: PAGES.length > 1 ? 'Photos' : 'Photo', sub: PAGES.length > 1 ? 'Une image par page' : 'Une image JPEG' }
  ]);
  if (!fmt) return;
  let name = await ask({ title: 'Nom du document', input: 'Scan ' + stamp(), ok: 'Enregistrer' });
  if (name === null) return; name = (name || '').trim().replace(/[\\/:*?"<>|]/g, '-') || 'Scan ' + stamp();
  busy('Chiffrement dans le coffre…'); await tick();
  try {
    const now = Date.now();
    if (fmt === 'pdf') {
      const pg = []; for (const p of PAGES) pg.push({ jpg: await jpg(p.out), w: p.out.width, h: p.out.height });
      const bytes = SC.pdf(pg), id = newId();
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
      PAGES.push({ src, q: q || inset(src.width, src.height, 0), rot: 0, f: FILT, out: null, url: null, auto: !!q });
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
E('scCam').querySelectorAll('.mode button').forEach(b => b.onclick = () => { AUTO = b.dataset.a === '1'; savePrefs(); drawMode(); });
function drawMode() { E('scCam').querySelectorAll('.mode button').forEach(b => b.classList.toggle('on', (b.dataset.a === '1') === AUTO)); E('scShot').classList.toggle('auto', AUTO); }
E('scX').onclick = async () => {
  if (PAGES.length && !(await ask({ title: 'Abandonner le scan ?', text: `${PAGES.length} page${PAGES.length > 1 ? 's' : ''} non enregistrée${PAGES.length > 1 ? 's' : ''} seront perdues.`, ok: 'Abandonner', danger: true }))) return;
  scanClose();
};

/* ---------- Ouverture / fermeture ---------- */
window.scanOpen = () => {
  if (!KEY) return; open = true; PAGES = []; CUR = 0; lastQ = null; need = null; stable = 0; cool = 0; revFrom = false;
  drawPg(); drawMode(); pane('scCam'); hint('Placez le document dans l’écran', false); show('scan'); camStart();
};
function scanClose(silent) {
  open = false; camStop(); busy();
  PAGES.forEach(p => p.url && URL.revokeObjectURL(p.url)); PAGES = [];
  if (!silent) show('vault');
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
