// Fonctionne hors ligne. Les fichiers du coffre ne passent jamais par ici (ils restent dans IndexedDB).
const C = 'notes-v13', FILES = ['./', 'index.html', 'app.js', 'manifest.json', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png', 'favicon-32.png', 'oauth.html', 'oauth.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(C).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' }))))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== C).map(x => caches.delete(x)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  // Photos et vidéos envoyées par l'appli Android (« Partager » ou « Importer et effacer de la galerie »)
  if (e.request.method === 'POST' && u.origin === location.origin && /\/share-target\/?$/.test(u.pathname)) { e.respondWith(shareIn(e.request)); return; }
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  // toujours la dernière version en ligne (sans cache du navigateur), sinon la copie hors ligne
  e.respondWith(fetch(e.request, { cache: 'no-store' }).then(r => { const cp = r.clone(); caches.open(C).then(c => c.put(e.request, cp)); return r; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});

/* ---------- Boîte d'arrivée chiffrée ----------
   Le coffre est fermé quand les fichiers arrivent : on les chiffre tout de suite avec la clé PUBLIQUE de la boîte
   d'arrivée (seul le vrai code peut ouvrir la clé privée). Ils rejoignent le coffre à la prochaine ouverture. */
const idb = () => new Promise((ok, ko) => {
  const r = indexedDB.open('coffre', 1);
  r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('meta'); d.createObjectStore('items', { keyPath: 'id' }); d.createObjectStore('blobs', { keyPath: 'id' }); };
  r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error);
});
async function shareIn(req) {
  let n = 0, nn = 0, bad = 0;
  const back = x => Response.redirect(new URL('./?shared=' + x + (nn ? '&notes=' + nn : '') + (bad ? '&bad=' + bad : ''), location.href).href, 303);
  try {
    const fd = await req.formData();
    const all = fd.getAll('media').filter(f => f && typeof f === 'object' && 'size' in f);
    const d = await idb();
    /* Notes (Samsung Notes « Partager » en texte ou Word) : elles vont dans le bloc-notes, pas dans le coffre */
    const notes = [];
    const txt = [fd.get('title'), fd.get('text')].filter(x => typeof x === 'string' && x.trim()).join('\n').trim();
    if (txt) notes.push({ txt, upd: Date.now() });
    const unread = [];   // note illisible : jamais perdue, elle va dans le coffre comme fichier
    for (const f of all.filter(isNoteFile)) { let o = null; try { o = await noteFromFile(f); } catch (e) {} if (o) notes.push(o); else unread.push(f); }
    bad = unread.length;
    if (notes.length) {
      await new Promise((ok, ko) => {
        const t = d.transaction('meta', 'readwrite'), st = t.objectStore('meta'), g = st.get('notes');
        g.onsuccess = () => { const L = Array.isArray(g.result) ? g.result : []; notes.forEach(o => { const d = autoDate(o.name || ''), n = { id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), txt: o.txt, upd: o.upd }; if (o.src) n.src = o.src; if (d) n.cre = d; if (!L.some(x => x.txt.trim() === n.txt.trim())) L.push(n); }); st.put(L, 'notes'); };
        t.oncomplete = ok; t.onerror = () => ko(t.error);
      });
      nn = notes.length;
    }
    const files = all.filter(f => !isNoteFile(f)).concat(unread);
    const pub = await new Promise(ok => { const g = d.transaction('meta').objectStore('meta').get('inboxPub'); g.onsuccess = () => ok(g.result || null); g.onerror = () => ok(null); });
    const pk = pub ? await crypto.subtle.importKey('spki', pub, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']) : null;
    for (const f of files) {
      const meta = new TextEncoder().encode(JSON.stringify({ name: f.name || 'fichier', type: f.type || 'application/octet-stream', size: f.size, t: f.lastModified || Date.now() }));
      let rec;
      if (pk) {
        const ak = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
        const iv = crypto.getRandomValues(new Uint8Array(12)), miv = crypto.getRandomValues(new Uint8Array(12));
        rec = {
          k: await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pk, await crypto.subtle.exportKey('raw', ak)),
          iv, data: await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, ak, await f.arrayBuffer()),
          miv, m: await crypto.subtle.encrypt({ name: 'AES-GCM', iv: miv }, ak, meta)
        };
      } else {
        rec = { raw: 1, data: await f.arrayBuffer(), m: meta };   // coffre pas encore préparé : gardé tel quel, rangé à la prochaine ouverture
      }
      await new Promise((ok, ko) => {
        const t = d.transaction('meta', 'readwrite');
        t.objectStore('meta').put(rec, 'in_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
        t.oncomplete = ok; t.onerror = () => ko(t.error); t.onabort = () => ko(t.error);
      });
      n++;
    }
  } catch (e) { return back('err'); }
  return back(n);
}

/* ---------- Lecture des notes importées (Samsung Notes : « Fichier texte » ou « Word ») ---------- */
async function zipEntry(buf, want) {   // lit un fichier dans un .docx (zip), sans bibliothèque
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let e = u8.length - 22; while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) return null;
  let p = dv.getUint32(e + 16, true); const n = dv.getUint16(e + 10, true);
  for (let i = 0; i < n; i++) {
    const meth = dv.getUint16(p + 10, true), csz = dv.getUint32(p + 20, true), fl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + fl));
    if (name === want) {
      const s = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true), raw = u8.subarray(s, s + csz);
      if (meth === 0) return new TextDecoder().decode(raw);
      return await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
    }
    p += 46 + fl + xl + cl;
  }
  return null;
}
const xmlTxt = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&amp;/g, '&');
/* ---------- Lecture des notes Samsung Notes (.sdocx) : titre + texte (pas les dessins) ----------
   Format décrit par le projet libre « sdocx » (twangodev/sdocx, rétro-ingénierie) ; lecture écrite ici. */
async function zipBytes(buf, want) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let e = u8.length - 22; while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) return null;
  let p = dv.getUint32(e + 16, true); const n = dv.getUint16(e + 10, true);
  for (let i = 0; i < n; i++) {
    const meth = dv.getUint16(p + 10, true), csz = dv.getUint32(p + 20, true), fl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + fl));
    if (want instanceof RegExp ? want.test(name) : name === want) {
      const s = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true), raw = u8.subarray(s, s + csz);
      if (meth === 0) return raw.slice();
      return new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    }
    p += 46 + fl + xl + cl;
  }
  return null;
}
function zipNames(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf), out = [];
  let e = u8.length - 22; while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) return out;
  let p = dv.getUint32(e + 16, true); const n = dv.getUint16(e + 10, true);
  for (let i = 0; i < n && p + 46 <= u8.length; i++) {
    const fl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    out.push(new TextDecoder().decode(u8.subarray(p + 46, p + 46 + fl))); p += 46 + fl + xl + cl;
  }
  return out;
}
function sdocxText(raw) {
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength); let p = 0;
  const u8 = () => raw[p++], u16 = () => { const v = dv.getUint16(p, true); p += 2; return v; }, u32 = () => { const v = dv.getUint32(p, true); p += 4; return v; };
  const mask = () => { const n = u8(); p += n; };
  /* un objet texte : cadre « base », cadre 6 (forme), cadre 7 (texte) -> texte UTF-16 */
  const textObj = (b) => {
    if (!b || b.length < 12) return '';
    const d = new DataView(b.buffer, b.byteOffset, b.byteLength); let q = 0;
    const frame = () => {
      const size = d.getUint32(q, true); if (size < 12 || q + size > b.length) throw new Error('cadre');
      const data = b.subarray(q + 4, q + size); q += size;
      const fd = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const kind = fd.getInt16(0, true), flexOff = fd.getUint32(2, true);
      let h = 6; const pm = data[h]; h += 1 + pm; const fm = data[h]; const fields = data.subarray(h + 1, h + 1 + fm); h += 1 + fm;
      const anyField = fields.some(x => x);
      const fixedEnd = flexOff === 0 && !anyField ? size : flexOff;
      return { kind, fields, flex: data.subarray(fixedEnd - 4) };
    };
    frame(); frame();                     // base de l'objet, forme
    const t = frame(); if (t.kind !== 7 || !(t.fields[0] & 1)) return '';
    const f = t.flex, fdv = new DataView(f.buffer, f.byteOffset, f.byteLength);
    const n = fdv.getUint32(4, true);     // [taille du bloc][nombre de caractères][texte UTF-16]
    return new TextDecoder('utf-16le').decode(f.subarray(8, 8 + n * 2));
  };
  u32(); mask(); mask(); u32();           // en-tête, masques, version
  const idn = u16(); if (idn !== 0xffff) p += idn * 2;   // identifiant de la note
  u32();                                  // révision
  const created = Number(dv.getBigInt64(p, true)); p += 8;
  const modified = Number(dv.getBigInt64(p, true)); p += 8;
  p += 16; u32();                         // dimensions, marges, version minimale
  const ts = u32(); let title = ''; try { title = textObj(raw.subarray(p, p + ts)); } catch (e) {} p += ts;
  const bs = u32(), bb = raw.subarray(p, p + bs); let body = ''; try { body = textObj(bb); } catch (e) {}
  if (!body.replace(/[\uFFFC\s]/g, '')) { const r = sdocxRuns(raw.subarray(p)); body = r.filter((x, i) => !r.slice(0, i).some(y => y.includes(x))).join('\n'); }   // texte rangé dans des tableaux
  const clean = s => s.replace(/\uFFFC/g, '').replace(/[\u2028\u2029\r]/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const okT = t => t > 9.4e11 && t < Date.now() + 864e5;  // millisecondes plausibles
  return { title: clean(title), body: clean(body), t: okT(modified) ? modified : okT(created) ? created : 0 };
}
/* repli : chaînes UTF-16 précédées de leur longueur (u32) — texte des tableaux, zones de texte des pages */
function sdocxRuns(b, strict) {
  const d = new DataView(b.buffer, b.byteOffset, b.byteLength), out = [];
  const ok = c => c === 9 || c === 10 || c === 13 || c === 0x2029 || c === 0x2028 || c === 0xFFFC || (c >= 0x20 && c < 0xD800) || (c >= 0xE000 && c < 0xFFF0);
  for (let i = 0; i + 6 <= b.length; i++) {
    const n = d.getUint32(i, true); if (n < 2 || n > 200000 || i + 4 + n * 2 > b.length) continue;
    let j = 0; for (; j < n; j++) if (!ok(d.getUint16(i + 4 + j * 2, true))) break;
    if (j < n) continue;
    const s = new TextDecoder('utf-16le').decode(b.subarray(i + 4, i + 4 + n * 2));
    if (!/\p{L}/u.test(s) || /^[0-9a-f-]{20,}$/i.test(s)) continue;
    if (!/^[\t\n\r\u0020-\u024F\u0370-\u06FF\u0750-\u077F\u1E00-\u1EFF\u2000-\u206F\u20A0-\u20CF\uFFFC]+$/.test(s) && (strict || s.length < 4 || !/\s/.test(s))) continue;   // écarte les données binaires qui ressemblent à du texte
    if ((s.match(/\p{L}/gu) || []).length < 2) continue;
    out.push(s); i += 3 + n * 2;
  }
  return out;
}

const AUTO_NAME = /^(?:(?:samsung[ _-]?)?notes?|m[eé]mo|texte?|fichier|document|scan)?[ _-]*(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})(?:[ _T.-]*(\d{2})[-_.:h]?(\d{2})(?:[-_.:]?(\d{2}))?)?[^\s]*$/i;
const autoName = s => AUTO_NAME.test((s || '').replace(/\.[^.\s]+$/, '').trim()) || /^(note|memo|texte|text|fichier)[-_ ]?\d*$/i.test((s || '').replace(/\.[^.\s]+$/, '').trim());
function autoDate(s) {   // « Note_20261123_100512 » → date
  const m = AUTO_NAME.exec((s || '').replace(/\.[^.\s]+$/, '').trim()); if (!m) return 0;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
  return d > 9.4e11 && d < Date.now() + 864e5 ? d : 0;
}
async function noteFromFile(f) {
  const name = (f.name || 'Note').replace(/\.[^.]+$/, '');
  let txt = '';
  let upd = f.lastModified || Date.now();
  if (/\.sdocx$/i.test(f.name || '') || /sdoc/i.test(f.type || '')) {   // note Samsung Notes d'origine
    const buf = await f.arrayBuffer(), raw = await zipBytes(buf, 'note.note'); if (!raw) return null;
    let r; try { r = sdocxText(raw); } catch (e) { r = { title: '', body: '', t: 0 }; }
    if (r.t) upd = r.t;
    if (!r.body) {   // autre version du format : on cherche le texte dans la note et dans ses pages
      const runs = [...sdocxRuns(raw)];
      for (const pn of zipNames(buf).filter(x => /\.page$/i.test(x))) { const pb = await zipBytes(buf, pn); if (pb) runs.push(...sdocxRuns(pb, true)); }
      r.body = runs.filter((x, i) => x !== r.title && !runs.slice(0, i).some(y => y.includes(x))).join('\n').replace(/\uFFFC/g, '').trim();
    }
    txt = [r.title, r.body].filter(Boolean).join('\n');
    if (!txt) return null;
    return { txt: r.title || !name || autoName(name) ? txt : name + '\n' + txt, upd: autoDate(name) || upd, name: f.name, src: 'Samsung Notes' };
  } else if (/\.docx$/i.test(f.name) || /wordprocessingml/.test(f.type)) {
    const x = await zipEntry(await f.arrayBuffer(), 'word/document.xml'); if (!x) return null;
    txt = x.split(/<\/w:p>/).map(p => [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g)].map(m => m[1] != null ? xmlTxt(m[1]) : m[0].includes('tab') ? '\t' : '\n').join('')).join('\n');
  } else if (/\.html?$/i.test(f.name) || /html/.test(f.type)) {
    txt = xmlTxt((await f.text()).replace(/<(br|\/p|\/div|\/li|\/h\d)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ''));
  } else txt = await f.text();
  txt = txt.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!txt) return null;
  if (name && !txt.toLowerCase().startsWith(name.toLowerCase()) && !autoName(name)) txt = name + '\n' + txt;
  return { txt, upd: autoDate(name) || upd, name: f.name, src: 'Importée' };
}
const isNoteFile = f => /^text\//.test(f.type || '') || /wordprocessingml|msword|sdoc/.test(f.type || '') || /\.(txt|md|docx|sdocx|html?)$/i.test(f.name || '');
