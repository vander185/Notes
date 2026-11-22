// Fonctionne hors ligne. Les fichiers du coffre ne passent jamais par ici (ils restent dans IndexedDB).
const C = 'notes-v7b', FILES = ['./', 'index.html', 'app.js', 'manifest.json', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png', 'favicon-32.png', 'oauth.html', 'oauth.js'];
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
  const back = n => Response.redirect(new URL('./?shared=' + n, location.href).href, 303);
  let n = 0;
  try {
    const fd = await req.formData();
    const files = fd.getAll('media').filter(f => f && typeof f === 'object' && 'size' in f);
    const d = await idb();
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
