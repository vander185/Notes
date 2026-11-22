// Fonctionne hors ligne. Les fichiers du coffre ne passent jamais par ici (ils restent dans IndexedDB).
const C = 'notes-v8', FILES = ['./', 'index.html', 'app.js', 'manifest.json', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png', 'favicon-32.png', 'oauth.html', 'oauth.js'];
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
  let n = 0, nn = 0;
  const back = x => Response.redirect(new URL('./?shared=' + x + (nn ? '&notes=' + nn : ''), location.href).href, 303);
  try {
    const fd = await req.formData();
    const all = fd.getAll('media').filter(f => f && typeof f === 'object' && 'size' in f);
    const d = await idb();
    /* Notes (Samsung Notes « Partager » en texte ou Word) : elles vont dans le bloc-notes, pas dans le coffre */
    const notes = [];
    const txt = [fd.get('title'), fd.get('text')].filter(x => typeof x === 'string' && x.trim()).join('\n').trim();
    if (txt) notes.push({ txt, upd: Date.now() });
    for (const f of all.filter(isNoteFile)) { try { const o = await noteFromFile(f); if (o) notes.push(o); } catch (e) {} }
    if (notes.length) {
      await new Promise((ok, ko) => {
        const t = d.transaction('meta', 'readwrite'), st = t.objectStore('meta'), g = st.get('notes');
        g.onsuccess = () => { const L = Array.isArray(g.result) ? g.result : []; notes.forEach(o => L.push({ id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ...o })); st.put(L, 'notes'); };
        t.oncomplete = ok; t.onerror = () => ko(t.error);
      });
      nn = notes.length;
    }
    const files = all.filter(f => !isNoteFile(f));
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
async function noteFromFile(f) {
  const name = (f.name || 'Note').replace(/\.[^.]+$/, '');
  let txt = '';
  if (/\.docx$/i.test(f.name) || /wordprocessingml/.test(f.type)) {
    const x = await zipEntry(await f.arrayBuffer(), 'word/document.xml'); if (!x) return null;
    txt = x.split(/<\/w:p>/).map(p => [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g)].map(m => m[1] != null ? xmlTxt(m[1]) : m[0].includes('tab') ? '\t' : '\n').join('')).join('\n');
  } else if (/\.html?$/i.test(f.name) || /html/.test(f.type)) {
    txt = xmlTxt((await f.text()).replace(/<(br|\/p|\/div|\/li|\/h\d)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ''));
  } else txt = await f.text();
  txt = txt.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!txt) return null;
  if (name && !txt.toLowerCase().startsWith(name.toLowerCase()) && !/^(note|memo|texte|text|fichier)[-_ ]?\d*$/i.test(name)) txt = name + '\n' + txt;
  return { txt, upd: f.lastModified || Date.now() };
}
const isNoteFile = f => /^text\//.test(f.type || '') || /wordprocessingml|msword/.test(f.type || '') || /\.(txt|md|docx|html?)$/i.test(f.name || '');
