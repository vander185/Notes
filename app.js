'use strict';
if (window.top !== window.self) { document.documentElement.innerHTML = ''; throw new Error('cadre interdit'); }   // anti-piège (page cachée dans une autre)
/* =========================================================
   Coffre secret – tout est chiffré sur l'appareil (AES-GCM 256)
   Clé maître aléatoire, protégée par une clé dérivée du code
   (PBKDF2-SHA256, 310 000 itérations).
   ========================================================= */
const $ = s => document.querySelector(s);
const enc = new TextEncoder(), dec = new TextDecoder();
const ITER = 600000, OLD_ITER = 310000;   // recommandation OWASP 2023 pour PBKDF2-SHA256

/* ---------- Base de données (IndexedDB) ---------- */
let dbp;
function db() {
  return dbp || (dbp = new Promise((ok, ko) => {
    const r = indexedDB.open('coffre', 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('meta'); d.createObjectStore('items', { keyPath: 'id' }); d.createObjectStore('blobs', { keyPath: 'id' }); };
    r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error);
  }));
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((ok, ko) => {
    const t = d.transaction(store, mode), s = t.objectStore(store); let res;
    const q = fn(s); if (q) q.onsuccess = () => res = q.result;
    t.oncomplete = () => ok(res); t.onerror = () => ko(t.error); t.onabort = () => ko(t.error);
  });
}
const mget = k => tx('meta', 'readonly', s => s.get(k));
const mset = (k, v) => tx('meta', 'readwrite', s => s.put(v, k));

/* ---------- Chiffrement ---------- */
const rnd = n => crypto.getRandomValues(new Uint8Array(n));
async function kek(pin, salt, it = ITER) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: it, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
}
async function wrap(master, pin) {
  const salt = rnd(16), iv = rnd(12), k = await kek(pin, salt);
  const w = await crypto.subtle.wrapKey('raw', master, k, { name: 'AES-GCM', iv });
  return { salt, iv, w: new Uint8Array(w), it: ITER };
}
async function unwrap(rec, pin) {
  const k = await kek(pin, rec.salt, rec.it || OLD_ITER);
  return crypto.subtle.unwrapKey('raw', rec.w, k, { name: 'AES-GCM', iv: rec.iv }, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}
async function encB(key, buf) { const iv = rnd(12); return { iv, data: await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buf) }; }
const decB = (key, o) => crypto.subtle.decrypt({ name: 'AES-GCM', iv: o.iv }, key, o.data);
const encJ = (key, obj) => encB(key, enc.encode(JSON.stringify(obj)));
const decJ = async (key, o) => JSON.parse(dec.decode(await decB(key, o)));

/* ---------- État ---------- */
let KEY = null, ITEMS = [], TAB = 'all', URLS = [], idle, curIdx = -1, curUrl = null;
let CFG = { mode: 'calc', auto: 0 };   // auto : 0 = dès qu'on quitte l'appli, sinon minutes

/* ---------- Petits outils d'interface ---------- */
function show(id) { document.querySelectorAll('.scr').forEach(e => e.classList.toggle('on', e.id === id)); }
function toast(t, ms = 2200) { const e = $('#toast'); e.textContent = t; e.style.display = 'block'; clearTimeout(e._t); e._t = setTimeout(() => e.style.display = 'none', ms); }
function modal(html) { $('#mbox').innerHTML = html; $('#mod').classList.add('on'); }
function closeModal() { $('#mod').classList.remove('on'); $('#mbox').innerHTML = ''; }
$('#mod').addEventListener('click', e => { if (e.target.id === 'mod') closeModal(); });
function ask({ title, text = '', ok = 'OK', danger = false, input = null, ph = '', cancel = 'Annuler', pw = false }) {
  return new Promise(res => {
    modal(`<h3>${esc(title)}</h3>${text ? `<p>${text}</p>` : ''}${input !== null ? `<input id="min" value="${esc(input)}" placeholder="${esc(ph)}" autocomplete="off"${pw ? ` type="password" ${pw === 'txt' ? '' : 'inputmode="numeric" maxlength="12"'}` : ''}>` : ''}<div class="btns">${cancel ? `<button id="mno">${esc(cancel)}</button>` : ''}<button id="mok" class="${danger ? 'r' : 'p'}">${esc(ok)}</button></div>`);
    const i = $('#min'); if (i) { setTimeout(() => i.focus(), 50); i.onkeydown = e => { if (e.key === 'Enter') $('#mok').click(); }; }
    $('#mok').onclick = () => { const v = i ? i.value : true; closeModal(); res(v); };
    if ($('#mno')) $('#mno').onclick = () => { closeModal(); res(null); };
  });
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const size = b => b < 1024 ? b + ' o' : b < 1048576 ? (b / 1024).toFixed(0) + ' Ko' : b < 1073741824 ? (b / 1048576).toFixed(1).replace('.', ',') + ' Mo' : (b / 1073741824).toFixed(2).replace('.', ',') + ' Go';
const kindOf = t => /^image\//.test(t) ? 'photo' : /^video\//.test(t) ? 'video' : 'doc';
const docIcon = (n, t) => /pdf/.test(t) || /\.pdf$/i.test(n) ? '📕' : /word|\.docx?$/i.test(t + n) ? '📘' : /sheet|excel|\.xlsx?$|\.csv$/i.test(t + n) ? '📗' : /audio/.test(t) ? '🎵' : /zip|rar|7z/.test(t + n) ? '🗜️' : /text/.test(t) ? '📝' : '📄';

/* ---------- Pavé numérique (verrou + création) ---------- */
const PADL = { 1: '', 2: 'ABC', 3: 'DEF', 4: 'GHI', 5: 'JKL', 6: 'MNO', 7: 'PQRS', 8: 'TUV', 9: 'WXYZ', 0: '' };
function buildPad(el, onKey) {
  el.innerHTML = '';
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'x', '0', '⌫'].forEach(k => {
    const b = document.createElement('button');
    if (k === 'x') { b.className = 't'; b.textContent = ''; b.disabled = true; }
    else { if (k === '⌫') { b.className = 't'; b.innerHTML = '<svg class="i" viewBox="0 0 24 24" style="width:26px;height:26px"><path d="M9 6h11v12H9l-6-6z"/><path d="M12.5 9.5l5 5M17.5 9.5l-5 5"/></svg>'; b.setAttribute('aria-label', 'Effacer'); } else b.innerHTML = `<span>${k}</span><small>${PADL[k]}</small>`; b.onclick = () => { navigator.vibrate && navigator.vibrate(8); onKey(k); }; }
    el.appendChild(b);
  });
}
function drawDots(el, n, max = 12) { el.innerHTML = Array.from({ length: Math.max(4, Math.min(max, Math.max(n, 4))) }, (_, i) => `<i class="${i < n ? 'f' : ''}"></i>`).join(''); }
function shake(el) { el.classList.remove('err'); void el.offsetWidth; el.classList.add('err'); navigator.vibrate && navigator.vibrate([60, 40, 60]); }

/* ---------- Démarrage ---------- */
async function start() {
  if (!window.isSecureContext || !crypto.subtle) {
    document.body.innerHTML = '<div style="padding:30px;font-size:17px;line-height:1.5">Cette appli doit être ouverte depuis son adresse en <b>https://</b> (et non comme un fichier) pour pouvoir chiffrer vos fichiers.</div>';
    return;
  }
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(r => r.update()).catch(() => {});
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded && !KEY) { reloaded = true; location.reload(); } });
  }
  const c = await mget('cfg'); if (c) CFG = { ...CFG, ...c };
  const k = await mget('key');
  if (!k) return setupFlow();
  openLockScreen();
}
function openLockScreen() {
  KEY = null;
  if (CFG.mode === 'calc') { notesOpen(); }
  else {
    lockPin = ''; drawDots($('#ldots'), 0); $('#lmsg').textContent = ''; lockOk.style.opacity = .3; show('lock');
    mget('bio').then(b => { $('#lbio').classList.toggle('hide', !b); if (b && document.visibilityState === 'visible') setTimeout(() => { if (!KEY && $('#lock').classList.contains('on')) bioUnlock(); }, 350); });
  }
}

/* ---------- Création du coffre ---------- */
let sMode = 'calc', sPin = '', sFirst = null;
const MINPIN = 6;   // nouveaux codes : 6 chiffres minimum (les anciens codes à 4 chiffres restent valables)
function setupFlow() {
  sPin = ''; sFirst = null;
  $('#stitle').textContent = 'Créez votre coffre secret';
  $('#ssub').textContent = "Choisissez un code de 6 à 12 chiffres. Sans ce code, personne ne peut ouvrir vos fichiers (même pas vous : ne l'oubliez pas).";
  $('#smode').classList.remove('hide');
  drawDots($('#sdots'), 0); $('#smsg').textContent = '';
  addOkKey();
  show('setup');
}
document.querySelectorAll('#smode button').forEach(b => b.onclick = () => { sMode = b.dataset.m; document.querySelectorAll('#smode button').forEach(x => x.classList.toggle('on', x === b)); });
function addOkKey() {
  buildPad($('#spad'), async k => {
    $('#smsg').textContent = '';
    if (k === '⌫') sPin = sPin.slice(0, -1);
    else if (sPin.length < 12) sPin += k;
    drawDots($('#sdots'), sPin.length);
    okBtn.disabled = sPin.length < MINPIN;
    okBtn.style.opacity = sPin.length < MINPIN ? .3 : 1;
  });
  const okBtn = $('#spad').children[9];
  okBtn.disabled = true; okBtn.className = 't'; okBtn.textContent = 'OK'; okBtn.style.opacity = .3;
  okBtn.onclick = async () => {
    if (sPin.length < MINPIN) return;
    if (sFirst === null) {
      sFirst = sPin; sPin = ''; drawDots($('#sdots'), 0); okBtn.disabled = true; okBtn.style.opacity = .3;
      $('#stitle').textContent = 'Confirmez le code'; $('#ssub').textContent = 'Tapez le même code une deuxième fois.'; $('#smode').classList.add('hide');
      return;
    }
    if (sPin !== sFirst) { shake($('#sdots')); $('#smsg').textContent = 'Les deux codes sont différents. Recommencez.'; return setTimeout(setupFlow, 900); }
    $('#smsg').textContent = ''; $('#ssub').textContent = 'Création du coffre…';
    const master = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    await mset('key', await wrap(master, sPin));
    CFG.mode = sMode; await mset('cfg', CFG);
    KEY = master; sPin = ''; sFirst = null;
    await openVault();
    const how = CFG.mode === 'calc'
      ? "L'appli s'ouvre désormais comme un simple bloc-notes.<br><br>Pour ouvrir votre coffre : <b>tapez votre code dans la barre « Rechercher »</b>, puis touchez « Rechercher » (ou attendez une seconde)."
      : "L'appli vous demandera votre code à chaque ouverture.";
    ask({ title: 'Votre coffre est prêt ✅', text: how + "<br><br>Astuce : installez l'appli sur l'écran d'accueil (menu du navigateur → « Ajouter à l'écran d'accueil »).", ok: "J'ai compris", cancel: '' });
  };
}

/* ---------- Verrou classique ---------- */
let lockPin = '';
buildPad($('#lpad'), k => {
  $('#lmsg').textContent = '';
  if (k === '⌫') lockPin = lockPin.slice(0, -1); else if (lockPin.length < 12) lockPin += k;
  drawDots($('#ldots'), lockPin.length);
  lockOk.style.opacity = lockPin.length < 4 ? .3 : 1;
});
const lockOk = $('#lpad').children[9];
lockOk.disabled = false; lockOk.textContent = 'OK'; lockOk.style.opacity = .3;
lockOk.onclick = async () => {
  if (lockPin.length < 4) return;
  const w = await guardWait(); if (w) { lockPin = ''; drawDots($('#ldots'), 0); return showWait(w); }
  lockOk.textContent = '…';
  const ok = await tryUnlock(lockPin, 'écran de code');
  lockOk.textContent = 'OK';
  if (ok) { lockPin = ''; drawDots($('#ldots'), 0); lockOk.style.opacity = .3; } else lockFail();
}
async function lockFail() {
  lockPin = ''; drawDots($('#ldots'), 0); shake($('#ldots'));
  const w = await guardWait();
  if (w) showWait(w); else $('#lmsg').textContent = 'Code incorrect';
}
let waitT;
function showWait(ms) {
  clearInterval(waitT);
  const tick = () => { const s = Math.ceil((ms -= 1000) / 1000 + 1); if (s <= 0) { clearInterval(waitT); $('#lmsg').textContent = ''; return; } $('#lmsg').textContent = `Trop d’essais. Réessayez dans ${s >= 60 ? Math.ceil(s / 60) + ' min' : s + ' s'}.`; };
  tick(); waitT = setInterval(tick, 1000);
}
$('#lbio').onclick = () => bioUnlock();

/* Le vrai code ouvre le vrai coffre ; le faux code ouvre le coffre leurre */
let DECOY = false, SHORTPIN = false;
/* Anti-essais en série : le compteur est gardé dans l'appareil (il ne se remet pas à zéro en rechargeant la page) */
const DELAYS = [0, 0, 0, 0, 0, 30, 60, 300, 900];   // secondes d'attente après n échecs (au-delà : 1 h)
async function guardWait() { const g = (await mget('guard')) || { n: 0, until: 0 }; return Math.max(0, g.until - Date.now()); }
async function guardFail() { const g = (await mget('guard')) || { n: 0, until: 0 }; g.n++; g.until = Date.now() + (g.n < DELAYS.length ? DELAYS[g.n] : 3600) * 1000; await mset('guard', g); }
async function tryUnlock(pin, how = 'code') {
  if (await guardWait()) return false;
  let slot = 'key';
  try { KEY = await unwrap(await mget('key'), pin); DECOY = false; }
  catch (e) {
    const k2 = await mget('key2');
    try { if (!k2) throw 0; KEY = await unwrap(k2, pin); DECOY = true; slot = 'key2'; }
    catch (e2) { KEY = null; await guardFail(); await logFail(how); return false; }
  }
  await mset('guard', { n: 0, until: 0 });
  SHORTPIN = !DECOY && pin.length < MINPIN;
  // ancien coffre : on renforce la protection du code (600 000 itérations) sans rien demander
  try { const r = await mget(slot); if (!r.it || r.it < ITER) await mset(slot, await wrap(KEY, pin)); } catch (e) {}
  sessFails = 0; snapDone = false;
  await openVault(); return true;
}

/* ---------- Bloc-notes (vrai bloc-notes + porte secrète) ---------- */
let NOTES = [], curNote = null, nT;
const SEED = [
  { t: 'Courses', txt: 'Courses\n- lait\n- pain\n- œufs\n- tomates\n- riz', upd: Date.now() - 86400000 * 2 },
  { t: 'Idées', txt: 'Idées\nAppeler le garage pour le contrôle\nRéserver le resto samedi', upd: Date.now() - 86400000 * 9 }
];
/* une note importée dont la 1re ligne est un nom automatique (« Note_20261123_100512 ») :
   ce nom devient la date de la note et une étiquette, plus une ligne de texte */
function noteNorm(n) {
  if (!n || typeof n.txt !== 'string') return false;
  const L = n.txt.split('\n'), first = L[0].trim();
  const f0 = first.replace(/\.[^.\s]+$/, '');
  if (L.length < 2 || !AUTO_NAME.test(f0) || !(/^(?:(?:samsung[ _-]?)?notes?|m[eé]mo)[ _-]*\d{4}/i.test(f0) || /^\d{8}_\d{4,6}$/.test(f0))) return false;   // seulement les noms donnés par Samsung
  const d = autoDate(first);
  n.txt = L.slice(1).join('\n').replace(/^\s*\n/, '');
  if (d) n.cre = n.cre || d;
  n.src = n.src || (/sdocx|samsung/i.test(first) ? 'Samsung Notes' : 'Importée');
  return true;
}
function noteAdd(o) {   // ajoute une note importée (sans doublon) ; renvoie la note ou null
  const txt = (o.txt || '').slice(0, 2e6); if (!txt.trim()) return null;
  const n = { id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), txt, upd: +o.upd || Date.now() };
  if (o.src) n.src = o.src;
  const d = autoDate(o.name || ''); if (d) { n.cre = d; n.upd = d; }
  noteNorm(n);
  if (NOTES.some(x => x.txt.trim() === n.txt.trim())) return null;
  NOTES.push(n); return n;
}
async function notesLoad() {
  NOTES = (await mget('notes')) || null;
  if (!NOTES) { NOTES = SEED.map((n, i) => ({ id: 'n' + i, ...n })); await mset('notes', NOTES); return; }
  let ch = false; NOTES.forEach(n => { if (noteNorm(n)) ch = true; });
  const seen = new Set(), before = NOTES.length;   // doublons d'import
  NOTES = NOTES.filter(n => !n.src || !n.txt.trim() || (seen.has(n.txt.trim()) ? false : (seen.add(n.txt.trim()), true)));
  if (ch || NOTES.length !== before) await mset('notes', NOTES);
}
const nSave = () => mset('notes', NOTES);
const nDate = t => { const d = new Date(t), now = new Date(); return d.toDateString() === now.toDateString() ? d.toLocaleTimeString('fr-BE', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('fr-BE', { day: '2-digit', month: '2-digit', year: '2-digit' }); };
function notesDraw() {
  const q = $('#nsearch').value.trim().toLowerCase();
  const L = NOTES.filter(n => !q || n.txt.toLowerCase().includes(q)).sort((a, b) => b.upd - a.upd);
  const day = new Date(); day.setHours(0, 0, 0, 0); const d0 = day.getTime(), D = 86400000;
  const grp = t => t >= d0 ? "Aujourd'hui" : t >= d0 - D ? 'Hier' : t >= d0 - 7 * D ? '7 jours précédents' : t >= d0 - 30 * D ? '30 jours précédents' : String(new Date(t).getFullYear());
  let html = '', cur = null;
  L.forEach(n => {
    const g = grp(n.upd); if (g !== cur) { html += (cur ? '</div>' : '') + `<h5>${g}</h5><div class="ng">`; cur = g; }
    const lines = n.txt.split('\n').filter(x => x.trim()); const t = lines[0] || 'Nouvelle note', sub = lines[1] || 'Aucun texte supplémentaire';
    html += `<button class="ni" data-id="${n.id}"><b><span>${esc(t)}</span>${n.src ? `<i>${n.src === 'Samsung Notes' ? 'Samsung' : 'Importée'}</i>` : ''}</b><small><em>${nDate(n.upd)}</em>${esc(sub)}</small></button>`;
  });
  $('#nlist').innerHTML = L.length ? html + '</div>' : `<p style="text-align:center;color:#8e8e93;margin-top:40px">${q ? 'Aucun résultat' : 'Aucune note'}</p>`;
  $('#ncount').textContent = NOTES.length + (NOTES.length > 1 ? ' notes' : ' note');
}
async function notesOpen() { await notesLoad(); $('#nsearch').value = ''; notesDraw(); show('notes'); }
function noteEdit(n) {
  const fmt = x => new Date(x).toLocaleString('fr-BE', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  curNote = n; $('#ntext').value = n.txt; $('#ndate').textContent = fmt(n.upd);
  const s = $('#nsrc'); s.classList.toggle('hide', !n.src);
  if (n.src) s.textContent = (n.src === 'Samsung Notes' ? 'Importée de Samsung Notes' : 'Note importée') + (n.cre ? ' · créée le ' + new Date(n.cre).toLocaleDateString('fr-BE', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  show('nedit'); if (!n.txt) setTimeout(() => $('#ntext').focus(), 80);
}
$('#nlist').addEventListener('click', e => { const b = e.target.closest('.ni'); if (b) noteEdit(NOTES.find(n => n.id === b.dataset.id)); });
$('#nnew').onclick = () => { const n = { id: 'n' + Date.now().toString(36), txt: '', upd: Date.now() }; NOTES.push(n); noteEdit(n); };
$('#ntext').addEventListener('input', () => { if (!curNote) return; curNote.txt = $('#ntext').value; curNote.upd = Date.now(); clearTimeout(nT); nT = setTimeout(nSave, 400); });
$('#nback').onclick = async () => { if (curNote && !curNote.txt.trim()) NOTES = NOTES.filter(n => n !== curNote); curNote = null; notesDraw(); show('notes'); await nSave(); };
$('#ndel').onclick = async () => {
  if (curNote && curNote.txt.trim() && await sheet('Supprimer cette note ?', [{ v: 'del', dg: 1, label: 'Supprimer la note' }]) !== 'del') return;
  NOTES = NOTES.filter(n => n !== curNote); curNote = null; notesDraw(); show('notes'); await nSave();
};
$('#nshare').onclick = async () => {
  const txt = (curNote && curNote.txt || '').trim(); if (!txt) return;
  try { if (navigator.share) { await navigator.share({ text: txt }); return; } } catch (e) { if (e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(txt); toast('Note copiée'); } catch (e) { toast('Impossible de partager'); }
};
// bouton « OK » pour fermer le clavier pendant la saisie
$('#ntext').addEventListener('focus', () => { $('#ndone').classList.remove('hide'); $('#nshare').classList.add('hide'); });
$('#ntext').addEventListener('blur', () => { $('#ndone').classList.add('hide'); $('#nshare').classList.remove('hide'); });
$('#ndone').addEventListener('pointerdown', e => { e.preventDefault(); $('#ntext').blur(); });
function noteFlash(id) { requestAnimationFrame(() => { const b = $('#nlist').querySelector(`[data-id="${id}"]`); if (b) { b.classList.add('flash'); b.scrollIntoView({ block: 'center', behavior: 'smooth' }); } }); }
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

async function notesImport(files) {
  let n = 0;
  for (const f of files) {
    try { const o = await noteFromFile(f); if (o && noteAdd(o)) n++; } catch (e) { console.warn(e); }
  }
  await nSave(); notesDraw();
  toast(n ? `${n} note${n > 1 ? 's' : ''} importée${n > 1 ? 's' : ''}` : 'Aucune note lisible (les notes écrites à la main n’ont pas de texte)', 3000);
}
$('#nmore').onclick = () => sheet('Notes', [
  { v: 'imp', ico: '📥', cls: 'y', label: 'Importer des notes', sub: 'Notes Samsung (.sdocx), texte ou Word' }
], v => { if (v === 'imp') { pickerOpen = true; setTimeout(() => pickerOpen = false, 90000); $('#nin').click(); } });
$('#nin').onchange = e => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) notesImport(fs); };
// notes reçues pendant que l'appli était fermée (partage depuis Samsung Notes) : déjà rangées par le service worker
/* notes envoyées par l'appli Android (lues sur le téléphone) : #addnote=<base64url du JSON> */
async function addNoteHash() {
  const h = location.hash; if (!h.startsWith('#addnote=')) return;
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
  try {
    const b = atob(h.slice(9).replace(/-/g, '+').replace(/_/g, '/')), u = Uint8Array.from(b, c => c.charCodeAt(0));
    const P = JSON.parse(new TextDecoder().decode(u));
    let seen = []; try { seen = JSON.parse(localStorage.getItem('addnote') || '[]'); } catch (e) {}
    if (!P || !Array.isArray(P.notes) || seen.includes(P.id)) return;
    await notesLoad();
    const added = P.notes.filter(o => o && typeof o.txt === 'string').map(noteAdd).filter(Boolean);
    await nSave(); try { localStorage.setItem('addnote', JSON.stringify(seen.concat(P.id).slice(-30))); } catch (e) {}
    notesDraw(); if (added[0]) noteFlash(added[0].id);
    const n = added.length; toast(n ? `${n} note${n > 1 ? 's' : ''} importée${n > 1 ? 's' : ''} dans le bloc-notes` : 'Cette note est déjà dans le bloc-notes', 4000);
  } catch (e) { console.warn('addnote', e); toast('La note n’a pas pu être ajoutée', 4000); }
}
addEventListener('hashchange', addNoteHash);
setTimeout(addNoteHash, 300);
(() => {
  const q = location.search, m = /[?&]notes=(\d+)/.exec(q), b = /[?&]bad=(\d+)/.exec(q), s = /[?&]shared=(\w+)/.exec(q);
  let msg = '';
  if (m && +m[1]) msg = `${m[1]} note${+m[1] > 1 ? 's' : ''} importée${+m[1] > 1 ? 's' : ''} dans le bloc-notes`;
  if (b && +b[1]) msg += (msg ? ' · ' : '') + `${b[1]} note${+b[1] > 1 ? 's' : ''} sans texte lisible : gardée${+b[1] > 1 ? 's' : ''} dans le coffre`;
  if (!msg && s && s[1] === 'err') msg = 'Le partage a échoué : réessayez';
  if (!msg && s && s[1] === '0') msg = 'Rien n’a été reçu du partage';
  if (msg) setTimeout(() => toast(msg, 5000), 800);
})();

// Porte secrète : le code tapé dans « Rechercher »
let sT, sTried = '';
async function secretTry() {
  const v = $('#nsearch').value.trim();
  if (!/^\d{4,12}$/.test(v) || v === sTried) return;
  if (await guardWait()) return;   // pendant l'attente : rien ne se passe, le bloc-notes reste un bloc-notes
  sTried = v;
  if (await tryUnlock(v, 'bloc-notes')) { $('#nsearch').value = ''; $('#nsearch').blur(); sTried = ''; }
}
$('#nsearch').addEventListener('input', () => { notesDraw(); sTried = ''; clearTimeout(sT); sT = setTimeout(secretTry, 900); });
$('#nsearch').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(sT); secretTry(); } });
// Empreinte en mode bloc-notes : appui long (1 s) sur le titre « Notes »
(() => {
  const h = $('#notes h1'); let t;
  const go = () => { t = setTimeout(async () => { if (await mget('bio')) bioUnlock(); }, 1000); };
  const stop = () => clearTimeout(t);
  h.addEventListener('pointerdown', go); ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => h.addEventListener(ev, stop));
  h.addEventListener('contextmenu', e => e.preventDefault());
})();

/* ---------- Empreinte / Face ID (WebAuthn + PRF) ----------
   L'empreinte débloque une clé secrète propre à ce téléphone, qui protège la clé du coffre. */
const bioSupported = () => !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create && window.isSecureContext);
async function prfKey(first) {
  const base = await crypto.subtle.importKey('raw', first, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('notes-bio'), info: enc.encode('master') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function bioGet(cid, salt) {
  const a = await navigator.credentials.get({ publicKey: { challenge: rnd(32), rpId: location.hostname, allowCredentials: [{ type: 'public-key', id: cid }], userVerification: 'required', timeout: 60000, extensions: { prf: { eval: { first: salt } } } } });
  const r = a.getClientExtensionResults().prf;
  if (!r || !r.results || !r.results.first) throw new Error('noprf');
  return new Uint8Array(r.results.first);
}
async function bioEnable() {
  const salt = rnd(32); pickerOpen = true;
  try {
    const c = await navigator.credentials.create({ publicKey: {
      rp: { name: 'Notes', id: location.hostname }, user: { id: rnd(16), name: 'Notes', displayName: 'Notes' }, challenge: rnd(32),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
      timeout: 60000, extensions: { prf: { eval: { first: salt } } } } });
    const ext = c.getClientExtensionResults().prf;
    if (!ext || ext.enabled === false) throw new Error('noprf');
    const cid = new Uint8Array(c.rawId);
    const first = ext.results && ext.results.first ? new Uint8Array(ext.results.first) : await bioGet(cid, salt);
    const k = await prfKey(first), e = await encB(k, await crypto.subtle.exportKey('raw', KEY));
    await mset('bio', { cid, salt, iv: e.iv, data: e.data });
  } finally { pickerOpen = false; }
}
async function bioUnlock() {
  const b = await mget('bio'); if (!b) return false;
  pickerOpen = true;
  try {
    const k = await prfKey(await bioGet(b.cid, b.salt));
    KEY = await crypto.subtle.importKey('raw', await decB(k, b), { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    DECOY = false; sessFails = 0; snapDone = false;
    await openVault(); return true;
  } catch (e) { KEY = null; return false; }
  finally { pickerOpen = false; }
}

/* ---------- Tentatives ratées + photo de l'intrus ----------
   La photo est chiffrée avec une clé publique : on peut la prendre sans ouvrir le coffre,
   mais seul le vrai code peut la regarder. */
let sessFails = 0, snapDone = false;
async function logFail(how) {
  sessFails++;
  const log = (await mget('log')) || [], e = { t: Date.now(), how };
  if (CFG.intr && sessFails >= 3 && !snapDone) { snapDone = true; try { e.ph = await snapIntruder(); } catch (x) { console.warn(x); } }
  log.push(e); while (log.length > 60) log.shift();
  await mset('log', log);
}
async function snapIntruder() {
  const pub = await mget('intrPub'); if (!pub) return null;
  try { const p = await navigator.permissions.query({ name: 'camera' }); if (p.state !== 'granted') return null; } catch (e) { return null; }
  const st = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 720 } }, audio: false });
  try {
    const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.srcObject = st; await v.play();
    await new Promise(r => setTimeout(r, 900));
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext('2d').drawImage(v, 0, 0);
    const jpg = await new Promise(r => c.toBlob(r, 'image/jpeg', .8));
    const ak = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
    const e = await encB(ak, await jpg.arrayBuffer());
    const pk = await crypto.subtle.importKey('spki', pub, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
    return { k: await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pk, await crypto.subtle.exportKey('raw', ak)), iv: e.iv, d: e.data };
  } finally { st.getTracks().forEach(t => t.stop()); }
}
async function intrPhotoUrl(ph) {
  const pr = await mget('intrPriv'); if (!pr || !ph) return null;
  const priv = await crypto.subtle.importKey('pkcs8', await decB(KEY, pr), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
  const ak = await crypto.subtle.importKey('raw', await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, priv, ph.k), 'AES-GCM', false, ['decrypt']);
  const u = URL.createObjectURL(new Blob([await decB(ak, { iv: ph.iv, data: ph.d })], { type: 'image/jpeg' })); URLS.push(u); return u;
}
const when = t => new Date(t).toLocaleString('fr-BE', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
async function checkIntruders() {
  if (DECOY || !KEY) return;
  const log = (await mget('log')) || [], seen = CFG.seen || 0, news = log.filter(e => e.t > seen);
  CFG.seen = Date.now(); await mset('cfg', CFG);
  if (!news.length || (news.length < 2 && !news.some(e => e.ph))) return;
  const imgs = []; for (const e of news) if (e.ph) { try { imgs.push(await intrPhotoUrl(e.ph)); } catch (x) {} }
  ask({ title: `⚠️ ${news.length} tentative${news.length > 1 ? 's' : ''} d'ouverture`, text: `Depuis votre dernière visite, quelqu'un a tapé un mauvais code ${news.length} fois (dernière fois : ${when(news[news.length - 1].t)}).${imgs.length ? '<div class="intr">' + imgs.map(u => `<img src="${u}" alt="">`).join('') + '</div>' : ''}`, ok: 'OK', cancel: '' });
}

/* ---------- Boîte d'arrivée (fichiers envoyés par l'appli Android pendant que le coffre est fermé) ---------- */
const IS_ANDROID = /Android/i.test(navigator.userAgent);
const IS_APK = (() => { try { if (/^android-app:\/\/io\.github\.vander185\.notes/.test(document.referrer)) localStorage.setItem('apk', '1'); return localStorage.getItem('apk') === '1'; } catch (e) { return false; } })();
async function inboxKeys() {
  if (DECOY || (await mget('inboxPub'))) return;
  const kp = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
  await mset('inboxPriv', await encB(KEY, await crypto.subtle.exportKey('pkcs8', kp.privateKey)));
  await mset('inboxPub', await crypto.subtle.exportKey('spki', kp.publicKey));
}
async function inboxFile() {
  if (DECOY || !KEY) return;
  const keys = (await tx('meta', 'readonly', s => s.getAllKeys())).filter(k => /^in_/.test(k));
  if (!keys.length) return;
  let priv = null, n = 0;
  try { const pr = await mget('inboxPriv'); if (pr) priv = await crypto.subtle.importKey('pkcs8', await decB(KEY, pr), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']); } catch (e) {}
  const bar = $('#bar'); bar.classList.remove('hide');
  for (const k of keys) {
    $('#bartxt').textContent = `Rangement dans le coffre ${n + 1} / ${keys.length}`; $('#barp').style.width = (n / keys.length * 100) + '%';
    try {
      const r = await mget(k); if (!r) continue;
      let buf, meta;
      if (r.raw) { buf = r.data; meta = JSON.parse(dec.decode(r.m)); }
      else {
        if (!priv) continue;
        const ak = await crypto.subtle.importKey('raw', await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, priv, r.k), 'AES-GCM', false, ['decrypt']);
        meta = JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: r.miv }, ak, r.m)));
        buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: r.iv }, ak, r.data);
      }
      await addFile(new File([buf], meta.name, { type: meta.type, lastModified: meta.t }));
      await tx('meta', 'readwrite', s => s.delete(k));
      n++;
    } catch (e) { console.warn('inbox', e); }
  }
  bar.classList.add('hide');
  if (n) { ITEMS.sort((a, b) => b.added - a.added); render(); toast(`${n} fichier${n > 1 ? 's' : ''} ajouté${n > 1 ? 's' : ''} depuis la galerie 🔐`, 3500); }
  try { if (/[?&]shared=/.test(location.search)) history.replaceState(null, '', location.pathname); } catch (e) {}
}

/* « Importer et effacer de la galerie » : ouvre l'appli Android Notes (v2), qui seule a le droit d'effacer */
function galDel() {
  pickerOpen = true; setTimeout(() => pickerOpen = false, 120000);
  const back = location.href.split('#')[0] + '#noapk';
  location.href = 'intent://import#Intent;scheme=notesimport;package=io.github.vander185.notes;S.browser_fallback_url=' + encodeURIComponent(back) + ';end';
}
addEventListener('hashchange', () => {
  if (location.hash !== '#noapk') return;
  history.replaceState(null, '', location.href.split('#')[0]);
  pickerOpen = false;
  ask({ title: 'Appli Android nécessaire', text: "Pour effacer les photos de la galerie, il faut l'appli <b>Notes pour Android (v2)</b> (fichier Notes.apk). Installez-la, puis ouvrez le coffre <b>depuis son icône</b>.<br><br>Sinon : importez normalement, puis supprimez les originaux vous-même dans la Galerie.", ok: 'OK', cancel: '' });
});

/* ---------- Ouverture du coffre ---------- */
let ALBUMS = [], ALBUM = null, SEL = null;
const albKey = () => DECOY ? 'albums2' : 'albums';
async function openVault() {
  const rows = await tx('items', 'readonly', s => s.getAll());
  ITEMS = [];
  for (const r of rows) { try { ITEMS.push({ id: r.id, ...(await decJ(KEY, r)) }); } catch (e) {} }
  ITEMS.sort((a, b) => b.added - a.added);
  await loadAlbums();
  TAB = 'all'; ALBUM = null; SEL = null; selEnd(true);
  document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('on', x.dataset.t === 'all'));
  // en mode faux coffre, l'écran est identique au vrai (sinon on devinerait que c'est un leurre)
  render(); show('vault'); bumpIdle();
  if (DECOY) { CS = null; GD = null; return; }
  await loadCloud(); await loadDrive();
  await inboxKeys(); await inboxFile();
  if (GD && !gLive() && navigator.userActivation && navigator.userActivation.isActive) gReconnect(); else sync();
  setTimeout(checkIntruders, 300);
  if (CS && CS.kv !== 2) setTimeout(() => { if (KEY && CS && CS.kv !== 2 && !$('#mod').classList.contains('on')) askUpgrade(); }, 1500);
}
function lockNow() {
  stopShow();
  KEY = null; ITEMS = []; ALBUMS = []; CS = null; GD = null; DECOY = false; SEL = null; cloudBadge();
  URLS.forEach(u => URL.revokeObjectURL(u)); URLS = [];
  closeViewer(true); closeModal();
  $('#grid').innerHTML = ''; $('#albums').innerHTML = '';
  openLockScreen();
}
$('#block').onclick = lockNow;

/* Verrouillage automatique */
function bumpIdle() { clearTimeout(idle); if (KEY && CFG.auto > 0) idle = setTimeout(lockNow, CFG.auto * 60000); }
['pointerdown', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, bumpIdle, { passive: true }));
let pickerOpen = false, hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now();
    if (KEY && !pickerOpen) { $('#shield').style.display = 'block'; if (CFG.auto === 0) lockNow(); }
  } else {
    $('#shield').style.display = 'none';
    if (KEY && !pickerOpen && CFG.auto > 0 && Date.now() - hiddenAt > CFG.auto * 60000) lockNow();
  }
});
window.addEventListener('pagehide', () => { if (KEY && !pickerOpen && CFG.auto === 0) lockNow(); });

/* ---------- Fenêtre de choix (feuille) ----------
   onPick est appelé directement pendant le toucher (nécessaire pour ouvrir l'appareil photo). */
function sheet(title, opts, onPick) {
  return new Promise(res => {
    modal(`<div class="sheet"><h3>${esc(title)}</h3>${opts.map((o, i) => `<button class="opt${o.dg ? ' dg' : ''}" data-i="${i}">${o.ico ? `<span class="ico ${o.cls || 'gr'}">${o.ico}</span>` : ''}<span class="lb">${esc(o.label)}${o.sub ? `<small>${esc(o.sub)}</small>` : ''}</span></button>`).join('')}<button class="cancel" id="mno">Annuler</button></div>`);
    $('#mbox').querySelectorAll('.opt').forEach(b => b.onclick = () => { const o = opts[+b.dataset.i]; if (onPick) onPick(o.v); closeModal(); res(o.v); });
    $('#mno').onclick = () => { closeModal(); res(null); };
  });
}

/* ---------- Albums ---------- */
async function loadAlbums() {
  ALBUMS = [];
  const r = await mget(albKey()); if (r) { try { ALBUMS = await decJ(KEY, r); } catch (e) {} }
  ITEMS.forEach(i => { if (i.album && !ALBUMS.includes(i.album)) ALBUMS.push(i.album); });
}
const saveAlbums = async () => mset(albKey(), await encJ(KEY, ALBUMS));
function drawAlbums() {
  const c = {}; ITEMS.forEach(i => { if (i.album) c[i.album] = (c[i.album] || 0) + 1; });
  $('#albums').innerHTML = `<button data-a="" class="${ALBUM === null ? 'on' : ''}">📁 Tous</button>` +
    ALBUMS.map((a, i) => `<button data-ai="${i}" class="${ALBUM === a ? 'on' : ''}">${esc(a)}<small>${c[a] || 0}</small></button>`).join('') +
    `<button data-new="1">＋ Album</button>`;
}
async function newAlbum() {
  const n = await ask({ title: 'Nouvel album', text: 'Nom de l’album :', input: '', ph: 'Ex. Papiers, Perso…', ok: 'Créer' });
  const name = (n || '').trim().slice(0, 40); if (!name) return null;
  if (!ALBUMS.includes(name)) { ALBUMS.push(name); await saveAlbums(); }
  return name;
}
(() => {
  const el = $('#albums'); let t, long = false;
  el.addEventListener('pointerdown', e => { const b = e.target.closest('[data-ai]'); long = false; if (!b) return; t = setTimeout(() => { long = true; albumMenu(ALBUMS[+b.dataset.ai]); }, 600); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => el.addEventListener(ev, () => clearTimeout(t)));
  el.addEventListener('contextmenu', e => e.preventDefault());
  el.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b || long) return;
    if (b.dataset.new) { const n = await newAlbum(); if (n) { ALBUM = n; render(); } return; }
    ALBUM = b.dataset.ai !== undefined ? ALBUMS[+b.dataset.ai] : null; render(); $('#grid').scrollTop = 0;
  });
})();
async function albumMenu(a) {
  const v = await sheet(`Album « ${a} »`, [{ v: 'ren', ico: '✏️', cls: 'b', label: 'Renommer l’album' }, { v: 'del', ico: '🗑', cls: 'r', label: 'Supprimer l’album', sub: 'Les fichiers restent dans le coffre', dg: true }]);
  if (v === 'ren') {
    const n = ((await ask({ title: 'Renommer l’album', input: a, ok: 'Enregistrer' })) || '').trim().slice(0, 40);
    if (!n || n === a) return;
    ALBUMS = ALBUMS.map(x => x === a ? n : x).filter((x, i, arr) => arr.indexOf(x) === i);
    await moveItems(ITEMS.filter(i => i.album === a), n, true); if (ALBUM === a) ALBUM = n;
  } else if (v === 'del') {
    ALBUMS = ALBUMS.filter(x => x !== a);
    await moveItems(ITEMS.filter(i => i.album === a), '', true); if (ALBUM === a) ALBUM = null;
  } else return;
  await saveAlbums(); render();
}
async function pickAlbum(title) {
  const opts = [{ v: '\u0000', ico: '🗂', cls: 'gr', label: 'Sans album' }, ...ALBUMS.map(a => ({ v: a, ico: '📁', cls: 'y', label: a })), { v: '\u0001', ico: '＋', cls: 'b', label: 'Nouvel album…' }];
  const v = await sheet(title, opts);
  if (v === null) return null;
  if (v === '\u0000') return '';
  if (v === '\u0001') return await newAlbum();
  return v;
}
async function moveItems(list, album, quiet) {
  for (const it of list) { it.album = album; await saveMeta(it); await markDirty(it.id); }
  if (!quiet) { render(); toast(album ? `Déplacé dans « ${album} »` : 'Retiré de l’album'); }
  sync();
}

/* ---------- Grille ---------- */
const KINDS = ['photo', 'video', 'doc', 'note'];
function counts() {
  const base = ALBUM === null ? ITEMS : ITEMS.filter(i => i.album === ALBUM), c = { all: base.length, photo: 0, video: 0, doc: 0, note: 0 };
  base.forEach(i => c[i.kind] = (c[i.kind] || 0) + 1);
  for (const k in c) $('#n_' + k).textContent = c[k] ? ' ' + c[k] : '';
}
function list() { return ITEMS.filter(i => (TAB === 'all' || i.kind === TAB) && (ALBUM === null || i.album === ALBUM)); }
function render() {
  counts(); drawAlbums();
  $('#vsub').textContent = ITEMS.length ? `${ITEMS.length} élément${ITEMS.length > 1 ? 's' : ''} · ${size(ITEMS.reduce((a, i) => a + (i.size || 0), 0))} · chiffré` : 'Chiffré sur cet appareil';
  const L = list(), g = $('#grid');
  if (!L.length) {
    const lab = { all: 'fichier', photo: 'photo', video: 'vidéo', doc: 'document', note: 'note secrète' }[TAB];
    g.innerHTML = `<div class="empty"><div class="eico"><svg class="i"><use href="#i-shield"/></svg></div>Aucun${TAB === 'note' || TAB === 'photo' ? 'e' : ''} ${lab} ${ALBUM ? 'dans cet album' : 'pour l’instant'}.<br>Appuyez sur <b style="display:inline;font-size:inherit">＋ Ajouter</b> pour prendre une photo, importer des fichiers ou écrire une note.</div>`;
    return;
  }
  g.innerHTML = L.map(it => {
    const sel = SEL && SEL.has(it.id) ? ' sel' : '';
    if (it.kind === 'note') { const p = (it.preview || '').split('\n'); return `<div class="cell${sel}" data-id="${it.id}"><div class="note"><b>${esc(it.name)}</b>${esc(p.slice(1).join('\n').trim().slice(0, 140))}</div></div>`; }
    if (it.thumb) return `<div class="cell${sel}" data-id="${it.id}"><img src="${it.thumb}" alt="" loading="lazy">${it.kind === 'video' ? `<span class="vd">▶ ${it.dur ? dur(it.dur) : ''}</span>` : ''}</div>`;
    return `<div class="cell${sel}" data-id="${it.id}"><div class="doc"><span>${it.kind === 'video' ? '🎬' : it.kind === 'photo' ? '🖼️' : docIcon(it.name, it.type)}</span>${esc(it.name)}<small style="color:#888">${size(it.size)}</small></div></div>`;
  }).join('');
}
const dur = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => { TAB = b.dataset.t; document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('on', x === b)); render(); $('#grid').scrollTop = 0; });

/* Toucher = ouvrir ; appui long = sélectionner */
(() => {
  const g = $('#grid'); let t, sx, sy, longDone = false;
  g.addEventListener('pointerdown', e => {
    const c = e.target.closest('.cell'); longDone = false; if (!c) return; sx = e.clientX; sy = e.clientY;
    t = setTimeout(() => { longDone = true; navigator.vibrate && navigator.vibrate(15); if (!SEL) selStart(c.dataset.id); else selToggle(c.dataset.id); }, 480);
  });
  g.addEventListener('pointermove', e => { if (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10) clearTimeout(t); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => g.addEventListener(ev, () => clearTimeout(t)));
  g.addEventListener('contextmenu', e => e.preventDefault());
  g.addEventListener('click', e => {
    const c = e.target.closest('.cell'); if (!c || longDone) return;
    if (SEL) selToggle(c.dataset.id); else openViewer(list().findIndex(x => x.id === c.dataset.id));
  });
})();

/* ---------- Sélection multiple ---------- */
function selStart(id) {
  SEL = new Set(id ? [id] : []);
  $('#vault').classList.add('selmode'); $('#vtop').classList.add('hide'); $('#stop').classList.remove('hide');
  $('#badd').classList.add('hide'); $('#selbar').classList.remove('hide');
  render(); selCount();
}
function selEnd(silent) {
  SEL = null;
  $('#vault').classList.remove('selmode'); $('#vtop').classList.remove('hide'); $('#stop').classList.add('hide');
  $('#badd').classList.remove('hide'); $('#selbar').classList.add('hide');
  if (!silent) render();
}
function selToggle(id) { SEL.has(id) ? SEL.delete(id) : SEL.add(id); const c = $(`#grid .cell[data-id="${id}"]`); if (c) c.classList.toggle('sel', SEL.has(id)); selCount(); }
function selCount() { const n = SEL ? SEL.size : 0; $('#scount').textContent = n + (n > 1 ? ' sélectionnés' : ' sélectionné'); $('#sall').textContent = SEL && n === list().length && n ? 'Aucun' : 'Tout'; }
const selItems = () => ITEMS.filter(i => SEL && SEL.has(i.id));
$('#bsel').onclick = () => { if (!ITEMS.length) return toast('Le coffre est vide'); selStart(); toast('Touchez les fichiers à sélectionner'); };
$('#scancel').onclick = () => selEnd();
$('#sall').onclick = () => { const L = list(); if (SEL.size === L.length) SEL.clear(); else L.forEach(i => SEL.add(i.id)); render(); selCount(); };
$('#s_mv').onclick = async () => {
  const L = selItems(); if (!L.length) return toast('Sélectionnez au moins un fichier');
  const a = await pickAlbum(`Déplacer ${L.length} fichier${L.length > 1 ? 's' : ''}`); if (a === null) return;
  await moveItems(L, a); selEnd();
};
$('#s_del').onclick = async () => {
  const L = selItems(); if (!L.length) return toast('Sélectionnez au moins un fichier');
  const ok = await ask({ title: `Supprimer ${L.length} fichier${L.length > 1 ? 's' : ''} ?`, text: 'Ils seront effacés définitivement du coffre.', ok: 'Supprimer', danger: true });
  if (!ok) return;
  for (const it of L) await removeItem(it);
  selEnd(); sync(); toast('Supprimé');
};
$('#s_dl').onclick = async () => {
  const L = selItems(); if (!L.length) return toast('Sélectionnez au moins un fichier');
  const ok = await ask({ title: 'Enregistrer hors du coffre ?', text: `Une copie <b>non protégée</b> de ${L.length > 1 ? 'ces ' + L.length + ' fichiers' : 'ce fichier'} sera enregistrée sur le téléphone, visible par tout le monde.`, ok: 'Enregistrer' });
  if (!ok) return;
  const files = []; for (const it of L) files.push(await asFile(it));
  await exportFiles(files); selEnd();
};
async function asFile(it) { const b = await getFile(it); return new File([b], it.kind === 'note' && !/\.txt$/i.test(it.name) ? it.name + '.txt' : it.name, { type: it.type }); }
async function exportFiles(files) {
  if (navigator.canShare && /Android|iPhone|iPad/i.test(navigator.userAgent) && navigator.canShare({ files })) {
    try { pickerOpen = true; await navigator.share({ files }); return; } catch (e) { if (e.name === 'AbortError') return; } finally { pickerOpen = false; }
  }
  for (const f of files) { const u = URL.createObjectURL(f), a = document.createElement('a'); a.href = u; a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 60000); await new Promise(r => setTimeout(r, 300)); }
}
async function removeItem(it) {
  const d1 = await db();
  await new Promise(r => { const t = d1.transaction(['items', 'blobs'], 'readwrite'); t.objectStore('items').delete(it.id); t.objectStore('blobs').delete(it.id); t.oncomplete = r; });
  ITEMS = ITEMS.filter(x => x.id !== it.id);
  await pendDel(it.id);
}

/* ---------- Ajout : appareil photo, caméra, galerie, documents, note ---------- */
let addSrc = 'gal';
$('#badd').onclick = () => sheet('Ajouter au coffre', [
  { v: 'cam', ico: '📷', cls: 'b', label: 'Prendre une photo', sub: 'Va directement dans le coffre, pas dans la Galerie' },
  { v: 'vid', ico: '🎥', cls: 'r', label: 'Filmer une vidéo', sub: 'Va directement dans le coffre' },
  ...(IS_ANDROID ? [{ v: 'gdel', ico: '🧹', cls: 'r', label: 'Importer et effacer de la galerie', sub: IS_APK ? 'Les originaux sont supprimés du téléphone' : 'Avec l’appli Android Notes (v2)' }] : []),
  { v: 'gal', ico: '🖼', cls: 'o', label: 'Importer photos et vidéos' },
  { v: 'doc', ico: '📄', cls: 'g', label: 'Importer des documents', sub: 'PDF, Word, fichiers…' },
  { v: 'note', ico: '📝', cls: 'y', label: 'Écrire une note secrète', sub: 'Codes, adresses, infos privées' }
], v => {
  if (v === 'note') return setTimeout(newSecretNote, 50);
  if (v === 'gdel') return galDel();
  const f = $('#fin'); f.value = ''; f.removeAttribute('capture'); addSrc = v;
  if (v === 'cam') { f.accept = 'image/*'; f.setAttribute('capture', 'environment'); f.multiple = false; }
  else if (v === 'vid') { f.accept = 'video/*'; f.setAttribute('capture', 'environment'); f.multiple = false; }
  else if (v === 'gal') { f.accept = 'image/*,video/*'; f.multiple = true; }
  else { f.accept = ''; f.multiple = true; }
  pickerOpen = true; f.click(); setTimeout(() => pickerOpen = false, 90000);
});
window.addEventListener('focus', () => setTimeout(() => { if (!$('#bar').classList.contains('hide')) return; pickerOpen = false; }, 1500));
const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}h${p(d.getMinutes())}`; };
$('#fin').onchange = async e => {
  pickerOpen = false;
  const files = [...e.target.files]; if (!files.length || !KEY) return;
  const cam = addSrc === 'cam' || addSrc === 'vid';
  const bar = $('#bar'); bar.classList.remove('hide');
  let done = 0, failed = 0;
  for (const f of files) {
    $('#bartxt').textContent = `Chiffrement ${done + 1} / ${files.length} : ${f.name}`;
    $('#barp').style.width = (done / files.length * 100) + '%';
    const ext = (f.name.match(/\.[a-z0-9]+$/i) || [f.type.startsWith('video') ? '.mp4' : '.jpg'])[0];
    try { await addFile(f, cam ? `${addSrc === 'vid' ? 'Vidéo' : 'Photo'} ${stamp()}${ext}` : null); } catch (err) { failed++; console.warn(err); }
    done++;
  }
  $('#barp').style.width = '100%';
  setTimeout(() => bar.classList.add('hide'), 400);
  ITEMS.sort((a, b) => b.added - a.added); render(); sync();
  if (failed) toast(`${failed} fichier(s) n'ont pas pu être ajoutés (trop lourds ?)`, 4000);
  else if (cam) toast(addSrc === 'vid' ? 'Vidéo cachée dans le coffre 🔐' : 'Photo cachée dans le coffre 🔐');
  else if (addSrc === 'gal') ask({ title: `${files.length} fichier${files.length > 1 ? 's' : ''} caché${files.length > 1 ? 's' : ''} 🔐`, text: "Ils sont maintenant chiffrés dans votre coffre.<br><br>" + (IS_APK ? "<b>Astuce :</b> la prochaine fois, choisissez « Importer et effacer de la galerie » : les originaux seront supprimés du téléphone automatiquement." : "<b>Important :</b> l'appli ne peut pas effacer les originaux. Supprimez-les vous-même de votre Galerie (et de « Récemment supprimés »).") + "<br><br>Astuce : utilisez « Prendre une photo » pour que vos prochaines photos ne passent jamais par la Galerie.", ok: 'OK', cancel: '' });
  else toast(`${files.length} fichier${files.length > 1 ? 's' : ''} caché${files.length > 1 ? 's' : ''} 🔐`);
};
async function storeItem(id, buf, meta) {
  const blob = await encB(KEY, buf), m = await encJ(KEY, meta), d1 = await db();
  await new Promise((ok, ko) => {
    const t = d1.transaction(['items', 'blobs'], 'readwrite');
    t.objectStore('blobs').put({ id, iv: blob.iv, data: blob.data });
    t.objectStore('items').put({ id, iv: m.iv, data: m.data });
    t.oncomplete = ok; t.onerror = () => ko(t.error); t.onabort = () => ko(t.error);
  });
}
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
async function addFile(f, name) {
  const id = newId(), kind = kindOf(f.type || '');
  let thumb = null, d = 0, w = 0, h = 0;
  try {
    if (kind === 'photo') ({ thumb, w, h } = await imgThumb(f));
    else if (kind === 'video') ({ thumb, d } = await vidThumb(f));
  } catch (e) {}
  const meta = { name: name || f.name || 'sans-nom', type: f.type || 'application/octet-stream', size: f.size, kind, thumb, dur: d, w, h, added: Date.now(), taken: f.lastModified || Date.now(), album: ALBUM || '' };
  await storeItem(id, await f.arrayBuffer(), meta);
  ITEMS.push({ id, ...meta });
}
async function newSecretNote() {
  const id = newId(), meta = { name: 'Nouvelle note', type: 'text/plain', size: 0, kind: 'note', preview: '', added: Date.now(), album: ALBUM || '' };
  await storeItem(id, new ArrayBuffer(0), meta);
  ITEMS.unshift({ id, ...meta });
  if (TAB !== 'all' && TAB !== 'note') { TAB = 'note'; document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('on', x.dataset.t === 'note')); }
  render(); openViewer(list().findIndex(x => x.id === id), true);
}
async function saveNote(it, text) {
  const buf = enc.encode(text), b = await encB(KEY, buf);
  it.size = buf.length; it.preview = text.slice(0, 300);
  it.name = ((text.split('\n').find(l => l.trim()) || 'Note sans titre').trim()).slice(0, 60);
  await tx('blobs', 'readwrite', s => s.put({ id: it.id, iv: b.iv, data: b.data }));
  await saveMeta(it); await markDirty(it.id, true); sync();
}
function drawThumb(src, sw, sh) {
  const S = 300, c = document.createElement('canvas'); c.width = c.height = S;
  const r = Math.max(S / sw, S / sh), dw = sw * r, dh = sh * r;
  c.getContext('2d').drawImage(src, (S - dw) / 2, (S - dh) / 2, dw, dh);
  return c.toDataURL('image/jpeg', .72);
}
function imgThumb(f) {
  return new Promise((ok, ko) => {
    const u = URL.createObjectURL(f), im = new Image();
    im.onload = () => { try { ok({ thumb: drawThumb(im, im.naturalWidth, im.naturalHeight), w: im.naturalWidth, h: im.naturalHeight }); } catch (e) { ko(e); } URL.revokeObjectURL(u); };
    im.onerror = () => { URL.revokeObjectURL(u); ko(new Error('img')); };
    im.src = u;
  });
}
function vidThumb(f) {
  return new Promise((ok, ko) => {
    const u = URL.createObjectURL(f), v = document.createElement('video');
    let done = false; const fin = (r, e) => { if (done) return; done = true; URL.revokeObjectURL(u); v.removeAttribute('src'); v.load(); r ? ok(r) : ko(e); };
    v.muted = true; v.playsInline = true; v.preload = 'metadata';
    v.onloadedmetadata = () => { v.currentTime = Math.min(1, (v.duration || 2) / 3); };
    v.onseeked = () => { try { fin({ thumb: drawThumb(v, v.videoWidth, v.videoHeight), d: v.duration }); } catch (e) { fin(null, e); } };
    v.onerror = () => fin(null, new Error('vid'));
    setTimeout(() => fin({ thumb: null, d: 0 }), 6000);
    v.src = u;
  });
}

/* ---------- Visionneuse (zoom, glisser, diaporama, notes) ---------- */
async function getFile(it) {
  const b = await tx('blobs', 'readonly', s => s.get(it.id));
  return new Blob([await decB(KEY, b)], { type: it.type });
}
let Z = { s: 1, x: 0, y: 0 }, noteDirty = false, showT = null;
function zApply() { const im = $('#vc img'); if (im) im.style.transform = `translate(${Z.x}px,${Z.y}px) scale(${Z.s})`; }
function zReset() { Z = { s: 1, x: 0, y: 0 }; zApply(); }
async function openViewer(i, focus) {
  if (noteDirty) await flushNote();
  curIdx = i; const it = list()[i]; if (!it) return;
  zReset(); noteDirty = false; $('#vsave').classList.add('hide');
  $('#vname').textContent = it.kind === 'note' ? 'Note secrète' : it.name + ' · ' + size(it.size);
  const vc = $('#vc'); vc.innerHTML = '<div style="color:#888">Déchiffrement…</div>';
  show('view');
  const L = list();
  $('#prev').style.visibility = i > 0 && it.kind !== 'note' ? 'visible' : 'hidden';
  $('#next').style.visibility = i < L.length - 1 && it.kind !== 'note' ? 'visible' : 'hidden';
  $('#vplay').classList.toggle('hide', it.kind !== 'photo' || L.filter(x => x.kind === 'photo').length < 2);
  $('#vbody').style.touchAction = it.kind === 'photo' ? 'none' : 'pan-y';
  try {
    const blob = await getFile(it);
    if (curIdx !== i) return;
    if (curUrl) URL.revokeObjectURL(curUrl);
    curUrl = URL.createObjectURL(blob); URLS.push(curUrl);
    if (it.kind === 'photo') vc.innerHTML = `<img src="${curUrl}" alt="" draggable="false">`;
    else if (it.kind === 'video') vc.innerHTML = `<video src="${curUrl}" controls autoplay playsinline></video>`;
    else if (it.kind === 'note') {
      vc.innerHTML = '<textarea id="vnote" placeholder="Écrivez votre note secrète…"></textarea>';
      const ta = $('#vnote'); ta.value = await blob.text();
      ta.oninput = () => { noteDirty = true; $('#vsave').classList.remove('hide'); };
      if (focus || !ta.value) setTimeout(() => ta.focus(), 80);
    }
    else if (/pdf/.test(it.type)) vc.innerHTML = `<iframe src="${curUrl}"></iframe>`;
    else if (/^text\/|json|csv/.test(it.type) && it.size < 2e6) vc.innerHTML = `<pre>${esc(await blob.text())}</pre>`;
    else if (/^audio\//.test(it.type)) vc.innerHTML = `<audio src="${curUrl}" controls autoplay></audio>`;
    else vc.innerHTML = `<div style="text-align:center;color:#ccc;padding:30px"><div style="font-size:64px">${docIcon(it.name, it.type)}</div><p>${esc(it.name)}</p><p style="color:#888">Ce type de fichier ne peut pas s'afficher ici.<br>Touchez « Enregistrer » pour l'ouvrir avec une autre appli.</p></div>`;
  } catch (e) { vc.innerHTML = '<div style="color:#f66">Impossible d’ouvrir ce fichier.</div>'; }
}
async function flushNote() {
  const it = list()[curIdx], ta = $('#vnote');
  if (!it || it.kind !== 'note' || !ta) return;
  if (noteDirty) { noteDirty = false; await saveNote(it, ta.value); $('#vsave').classList.add('hide'); render(); }
}
$('#vsave').onclick = async () => { await flushNote(); toast('Note enregistrée 🔐'); };
async function closeViewer(silent) {
  stopShow();
  if (!silent && KEY) {
    await flushNote();
    const it = list()[curIdx];
    if (it && it.kind === 'note' && !it.size) { await removeItem(it); sync(); }   // note vide : on ne la garde pas
  }
  const v = $('#vc video'); if (v) v.pause();
  $('#vc').innerHTML = '';
  if (curUrl) { URL.revokeObjectURL(curUrl); curUrl = null; }
  curIdx = -1; noteDirty = false;
  if (!silent && KEY) { render(); show('vault'); }
}
$('#vclose').onclick = () => closeViewer();
const goPrev = () => curIdx > 0 && openViewer(curIdx - 1);
const goNext = () => curIdx < list().length - 1 && openViewer(curIdx + 1);
$('#prev').onclick = () => { stopShow(); goPrev(); };
$('#next').onclick = () => { stopShow(); goNext(); };
document.addEventListener('keydown', e => {
  if (!$('#view').classList.contains('on') || $('#vnote')) return;
  if (e.key === 'ArrowLeft') $('#prev').click(); else if (e.key === 'ArrowRight') $('#next').click(); else if (e.key === 'Escape') closeViewer();
});
/* Gestes : glisser (photo suivante), pincer (zoom), double-toucher (zoom), déplacer (photo zoomée) */
(() => {
  const vb = $('#vbody'), P = new Map(); let pinch = null, pan = null, g = null, lastTap = 0;
  const dist = () => { const [a, b] = [...P.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  vb.addEventListener('pointerdown', e => {
    if (e.target.closest('.nav') || !$('#vc img')) { g = { x: e.clientX, y: e.clientY, multi: false, media: !!$('#vc video,#vc iframe,#vnote,#vc pre') }; return; }
    stopShow(); P.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (P.size === 1) {
      g = { x: e.clientX, y: e.clientY, multi: false }; pan = { x: e.clientX, y: e.clientY, zx: Z.x, zy: Z.y };
      const now = Date.now();
      if (now - lastTap < 280) { Z.s > 1 ? zReset() : (Z.s = 2.5, zApply()); lastTap = 0; g.dbl = true; } else lastTap = now;
    } else if (P.size === 2) { pinch = { d: dist(), s: Z.s }; if (g) g.multi = true; }
  });
  vb.addEventListener('pointermove', e => {
    if (!P.has(e.pointerId)) return;
    P.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && P.size === 2) { Z.s = Math.min(5, Math.max(1, pinch.s * dist() / pinch.d)); if (Z.s === 1) { Z.x = Z.y = 0; } zApply(); }
    else if (P.size === 1 && Z.s > 1 && pan) { Z.x = pan.zx + e.clientX - pan.x; Z.y = pan.zy + e.clientY - pan.y; zApply(); }
  });
  const up = e => {
    const wasPhoto = P.has(e.pointerId); P.delete(e.pointerId);
    if (P.size < 2) pinch = null;
    if (P.size === 1) { const [p] = [...P.values()]; pan = { x: p.x, y: p.y, zx: Z.x, zy: Z.y }; }
    if (!g || P.size) return;
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (!g.multi && !g.dbl && !g.media && (wasPhoto ? Z.s === 1 : true) && Math.abs(dx) > 60 && Math.abs(dy) < 90) { dx > 0 ? goPrev() : goNext(); }
    g = null;
  };
  ['pointerup', 'pointercancel'].forEach(ev => vb.addEventListener(ev, up));
})();
function stopShow() { if (showT) { clearInterval(showT); showT = null; $('#vplay').textContent = '▶'; } }
$('#vplay').onclick = () => {
  if (showT) return stopShow();
  $('#vplay').textContent = '⏸';
  showT = setInterval(() => {
    const L = list(); let j = curIdx + 1;
    while (j < L.length && L[j].kind !== 'photo') j++;
    if (j >= L.length) { j = L.findIndex(x => x.kind === 'photo'); }
    if (j < 0) return stopShow();
    const keep = showT; openViewer(j).then(() => { if (keep) { showT = keep; $('#vplay').textContent = '⏸'; $('#vplay').classList.remove('hide'); } });
  }, 3000);
};

$('#vdl').onclick = async () => {
  const it = list()[curIdx]; if (!it) return;
  await flushNote();
  const ok = await ask({ title: 'Enregistrer hors du coffre ?', text: 'Une copie <b>non protégée</b> de ce fichier sera enregistrée sur le téléphone, visible par tout le monde.', ok: 'Enregistrer' });
  if (!ok) return;
  await exportFiles([await asFile(it)]);
};
$('#vmv').onclick = async () => {
  const it = list()[curIdx]; if (!it) return;
  const a = await pickAlbum('Ranger dans un album'); if (a === null) return;
  await flushNote(); await moveItems([it], a);
  const L = list(); if (!L.includes(it)) { L.length ? openViewer(Math.min(curIdx, L.length - 1)) : closeViewer(); }
};
$('#vren').onclick = async () => {
  const it = list()[curIdx]; if (!it) return;
  if (it.kind === 'note') return toast('Le titre d’une note est sa première ligne');
  const n = await ask({ title: 'Renommer', input: it.name, ok: 'Enregistrer' });
  if (!n || !n.trim()) return;
  it.name = n.trim(); await saveMeta(it); await markDirty(it.id); sync();
  $('#vname').textContent = it.name + ' · ' + size(it.size); render();
};
$('#vdel').onclick = async () => {
  const it = list()[curIdx]; if (!it) return;
  const ok = await ask({ title: 'Supprimer définitivement ?', text: `« ${esc(it.name)} » sera effacé du coffre. Cette action est irréversible.`, ok: 'Supprimer', danger: true });
  if (!ok) return;
  noteDirty = false;
  await removeItem(it); render(); sync();
  const L = list();
  if (!L.length) closeViewer(); else openViewer(Math.min(curIdx, L.length - 1));
  toast('Supprimé');
};
async function saveMeta(it) {
  const { id, ...meta } = it; const m = await encJ(KEY, meta);
  await tx('items', 'readwrite', s => s.put({ id, iv: m.iv, data: m.data }));
}

/* ---------- Réglages ---------- */
async function drawSets() {
  document.querySelectorAll('#segMode button').forEach(b => b.classList.toggle('on', b.dataset.v === CFG.mode));
  document.querySelectorAll('#segAuto button').forEach(b => b.classList.toggle('on', +b.dataset.v === CFG.auto));
  $('#n_mode').innerHTML = CFG.mode === 'calc' ? "Ressemble à une appli de notes. Code à taper dans « Rechercher »." : "L'appli demande le code dès l'ouverture.";
  $('#e_pin').classList.toggle('hide', !SHORTPIN);
  if (DECOY) return;
  $('#r_bio').classList.toggle('hide', !bioSupported());
  $('#e_bio').textContent = (await mget('bio')) ? (CFG.mode === 'calc' ? 'Activé · appui long sur le titre « Notes »' : 'Activé') : 'Désactivé';
  $('#e_decoy').textContent = (await mget('key2')) ? 'Activé' : 'Ouvre un faux coffre si on vous force';
  $('#e_intr').textContent = CFG.intr ? 'Activée · après 3 codes faux' : 'Désactivée';
  const log = (await mget('log')) || [];
  $('#e_log').textContent = log.length ? `${log.length} · dernière ${when(log[log.length - 1].t)}` : 'Aucune';
}
$('#bset').onclick = async () => {
  drawSets(); drawCloud(); drawDrive(); show('sets'); $('#sets').scrollTop = 0;
  const used = ITEMS.reduce((a, i) => a + i.size, 0), c = { photo: 0, video: 0, doc: 0, note: 0 }; ITEMS.forEach(i => c[i.kind]++);
  const parts = [c.photo && `${c.photo} photo${c.photo > 1 ? 's' : ''}`, c.video && `${c.video} vidéo${c.video > 1 ? 's' : ''}`, c.doc && `${c.doc} doc${c.doc > 1 ? 's' : ''}`, c.note && `${c.note} note${c.note > 1 ? 's' : ''}`].filter(Boolean);
  let txt = (parts.join(' · ') || 'Vide') + ' — ' + size(used), pct = 0;
  try { const e = await navigator.storage.estimate(); if (e.quota) { pct = Math.min(100, e.usage / e.quota * 100); txt += ` sur ${size(e.quota)}`; } } catch (e) {}
  $('#e_space').textContent = txt; $('#e_meter').style.width = Math.max(2, pct) + '%';
};
$('#sback').onclick = () => show('vault');
$('#segMode').onclick = async e => {
  const b = e.target.closest('button'); if (!b || b.dataset.v === CFG.mode) return;
  CFG.mode = b.dataset.v; await mset('cfg', CFG); drawSets();
  toast(CFG.mode === 'calc' ? 'Le coffre est caché dans le bloc-notes' : "Écran de code classique activé");
};
$('#segAuto').onclick = async e => {
  const b = e.target.closest('button'); if (!b) return;
  CFG.auto = +b.dataset.v; await mset('cfg', CFG); drawSets(); bumpIdle();
};
const opens = async (rec, pin) => { try { if (!rec) return false; await unwrap(rec, pin); return true; } catch (e) { return false; } };
$('#r_pin').onclick = async () => {
  const mine = DECOY ? 'key2' : 'key', other = DECOY ? 'key' : 'key2';
  const old = await ask({ title: 'Changer le code', text: 'Code actuel :', input: '', ph: '••••', ok: 'Suivant', pw: true });
  if (old === null) return;
  if (!(await opens(await mget(mine), old))) return toast('Code actuel incorrect');
  const n1 = await ask({ title: 'Nouveau code', text: '6 à 12 chiffres :', input: '', ph: '••••', ok: 'Suivant', pw: true });
  if (n1 === null) return;
  if (!/^\d{6,12}$/.test(n1)) return toast('Le code doit faire 6 à 12 chiffres');
  if (await opens(await mget(other), n1)) return toast('Choisissez un autre code');
  const n2 = await ask({ title: 'Confirmez le nouveau code', input: '', ph: '••••', ok: 'Valider', pw: true });
  if (n2 !== n1) return toast('Les deux codes sont différents');
  await mset(mine, await wrap(KEY, n1)); if (!DECOY) SHORTPIN = false; drawSets();
  toast('Code modifié ✅'); sync();
};
/* Empreinte */
const decoyNo = () => { toast('Indisponible pour le moment', 2500); return true; };
$('#r_bio').onclick = async () => {
  if (DECOY) return decoyNo();
  if (await mget('bio')) {
    const v = await sheet('Empreinte / Face ID', [{ v: 'off', ico: '👆', cls: 'r', label: 'Désactiver', dg: true }]);
    if (v === 'off') { await tx('meta', 'readwrite', s => s.delete('bio')); drawSets(); toast('Empreinte désactivée'); }
    return;
  }
  const ok = await ask({ title: 'Ouvrir avec l’empreinte ou Face ID', text: (CFG.mode === 'calc' ? "En mode bloc-notes, faites un <b>appui long (1 seconde) sur le titre « Notes »</b> pour utiliser l'empreinte." : "L'empreinte vous sera proposée à chaque ouverture.") + "<br><br>Votre code reste toujours utilisable.", ok: 'Activer' });
  if (!ok) return;
  try { await bioEnable(); drawSets(); toast('Empreinte / Face ID activé ✅'); }
  catch (e) { console.warn(e); toast(e.name === 'NotAllowedError' ? 'Annulé' : "Ce téléphone ne permet pas encore l'ouverture par empreinte ici", 4000); }
};
/* Faux code */
async function decoyKey() {
  const r = await mget('key2r'); if (!r) return null;
  return crypto.subtle.importKey('raw', await decB(KEY, r), { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}
async function askNewDecoy() {
  const c1 = await ask({ title: 'Faux code', text: "Choisissez un code (6 à 12 chiffres) <b>différent</b> de votre vrai code. Il ouvrira un faux coffre, séparé du vrai.", input: '', ph: '••••', ok: 'Suivant', pw: true });
  if (c1 === null) return null;
  if (!/^\d{6,12}$/.test(c1)) { toast('Le code doit faire 6 à 12 chiffres'); return null; }
  if (await opens(await mget('key'), c1)) { toast("C'est votre vrai code : choisissez-en un autre"); return null; }
  const c2 = await ask({ title: 'Confirmez le faux code', input: '', ph: '••••', ok: 'Valider', pw: true });
  if (c2 !== c1) { toast('Les deux codes sont différents'); return null; }
  return c1;
}
$('#r_decoy').onclick = async () => {
  if (DECOY) return decoyNo();
  if (await mget('key2')) {
    const v = await sheet('Faux code', [{ v: 'chg', ico: '🔁', cls: 'b', label: 'Changer le faux code' }, { v: 'off', ico: '🗑', cls: 'r', label: 'Supprimer le faux code', sub: 'Le contenu du faux coffre sera effacé', dg: true }]);
    if (v === 'chg') { const c = await askNewDecoy(); if (!c) return; await mset('key2', await wrap(await decoyKey(), c)); toast('Faux code modifié ✅'); }
    else if (v === 'off') {
      const k2 = await decoyKey(), rows = await tx('items', 'readonly', s => s.getAll()), d1 = await db();
      for (const r of rows) { try { await decJ(k2, r); await new Promise(ok => { const t = d1.transaction(['items', 'blobs'], 'readwrite'); t.objectStore('items').delete(r.id); t.objectStore('blobs').delete(r.id); t.oncomplete = ok; }); } catch (e) {} }
      await tx('meta', 'readwrite', s => { s.delete('key2'); s.delete('key2r'); return s.delete('albums2'); });
      toast('Faux code supprimé');
    }
    return drawSets();
  }
  const ok = await ask({ title: 'Faux code 🎭', text: "Si quelqu'un vous oblige à ouvrir l'appli, tapez le <b>faux code</b> : il ouvre un faux coffre qui a l'air normal, et votre vrai coffre reste invisible.<br><br>Conseil : ouvrez ensuite le faux coffre et ajoutez-y quelques photos banales pour qu'il soit crédible.", ok: 'Créer le faux code' });
  if (!ok) return;
  const c = await askNewDecoy(); if (!c) return;
  const m2 = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  await mset('key2', await wrap(m2, c));
  await mset('key2r', await encB(KEY, await crypto.subtle.exportKey('raw', m2)));
  drawSets(); toast('Faux code créé ✅');
};
/* Photo de l'intrus */
$('#r_intr').onclick = async () => {
  if (DECOY) return decoyNo();
  if (CFG.intr) {
    const v = await sheet("Photo de l'intrus", [{ v: 'off', ico: '📸', cls: 'r', label: 'Désactiver', dg: true }]);
    if (v === 'off') { CFG.intr = false; await mset('cfg', CFG); drawSets(); }
    return;
  }
  const ok = await ask({ title: "Photo de l'intrus 📸", text: "Après <b>3 codes faux</b>, l'appli prend discrètement une photo avec la caméra avant. Vous la verrez à votre prochaine ouverture.<br><br>Le téléphone va vous demander l'autorisation d'utiliser la caméra : acceptez-la (c'est nécessaire pour que la photo se prenne sans rien afficher).", ok: 'Activer' });
  if (!ok) return;
  try {
    pickerOpen = true;
    const st = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false }); st.getTracks().forEach(t => t.stop());
    if (!(await mget('intrPub'))) {
      const kp = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
      await mset('intrPub', await crypto.subtle.exportKey('spki', kp.publicKey));
      await mset('intrPriv', await encB(KEY, await crypto.subtle.exportKey('pkcs8', kp.privateKey)));
    }
    CFG.intr = true; await mset('cfg', CFG); drawSets(); toast("Photo de l'intrus activée ✅");
  } catch (e) { toast("Accès à la caméra refusé : impossible d'activer", 3500); }
  finally { pickerOpen = false; }
};
/* Historique */
$('#r_log').onclick = async () => {
  if (DECOY) return ask({ title: "Tentatives d'ouverture", text: 'Aucune tentative avec un mauvais code. 👍', ok: 'OK', cancel: '' });
  const log = ((await mget('log')) || []).slice().reverse();
  if (!log.length) return ask({ title: "Tentatives d'ouverture", text: 'Aucune tentative avec un mauvais code. 👍', ok: 'OK', cancel: '' });
  const rows = [];
  for (const e of log.slice(0, 30)) {
    let u = null; if (e.ph) { try { u = await intrPhotoUrl(e.ph); } catch (x) {} }
    rows.push(`<div class="lg">${u ? `<img src="${u}" alt="">` : '<span class="ico r" style="width:54px;height:54px;flex:0 0 54px;font-size:22px">✋</span>'}<div>${esc(when(e.t))}<small>Code incorrect · ${esc(e.how || 'code')}</small></div></div>`);
  }
  modal(`<h3>Tentatives d'ouverture</h3><div style="max-height:55vh;overflow-y:auto;margin:6px 0 14px">${rows.join('')}</div><div class="btns"><button id="mclr">Effacer</button><button id="mok" class="p">OK</button></div>`);
  $('#mok').onclick = closeModal;
  $('#mclr').onclick = async () => { await mset('log', []); closeModal(); drawSets(); toast('Historique effacé'); };
};
$('#r_wipe').onclick = async () => {
  if (DECOY) {
    const v = await ask({ title: 'Tout effacer ?', text: `Les ${ITEMS.length} fichiers du coffre seront supprimés définitivement. Tapez <b>EFFACER</b> pour confirmer.`, input: '', ph: 'EFFACER', ok: 'Tout effacer', danger: true });
    if (!v || v.trim().toUpperCase() !== 'EFFACER') return;
    for (const it of [...ITEMS]) await removeItem(it);
    ALBUMS = []; await saveAlbums(); render(); show('vault'); return toast('Coffre vidé');
  }
  const v = await ask({ title: 'Tout effacer ?', text: `Les ${ITEMS.length} fichiers du coffre et votre code seront supprimés <b>de ce téléphone</b>. La sauvegarde en ligne, elle, est conservée (utilisez « Supprimer la sauvegarde en ligne » pour l'effacer aussi).<br><br>Tapez <b>EFFACER</b> pour confirmer.`, input: '', ph: 'EFFACER', ok: 'Tout effacer', danger: true });
  if (!v || v.trim().toUpperCase() !== 'EFFACER') return;
  const d1 = await db();
  await new Promise(r => { const t = d1.transaction(['items', 'blobs', 'meta'], 'readwrite'); ['items', 'blobs', 'meta'].forEach(s => t.objectStore(s).clear()); t.oncomplete = r; });
  KEY = null; ITEMS = []; CS = null; GD = null; gTok = null; CFG = { mode: 'calc', auto: 0, gcid: CFG.gcid }; setupFlow();
};

/* ---------- Sauvegarde chiffrée ----------
   Format : "COFFRE1" + longueur de l'en-tête (4 octets) + en-tête JSON + données chiffrées à la suite.
   Tout reste chiffré : il faut le code utilisé au moment de la sauvegarde pour la restaurer. */
const b64 = u => { let s = ''; const a = new Uint8Array(u); for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
$('#r_bak').onclick = async () => {
  if (!ITEMS.length) return toast('Le coffre est vide');
  const total = ITEMS.reduce((a, i) => a + i.size, 0);
  const pw = await ask({ title: 'Créer une sauvegarde', text: `${ITEMS.length} fichiers · ${size(total)}<br><br>Choisissez un <b>mot de passe de sauvegarde</b> (8 caractères minimum, lettres et chiffres). Il sera demandé pour restaurer ce fichier. Sans lui, personne ne peut l'ouvrir.`, input: '', ph: 'Mot de passe de sauvegarde', ok: 'Suivant', pw: 'txt' });
  if (pw === null) return;
  if (pw.length < 8) return toast('8 caractères minimum', 3000);
  const pw2 = await ask({ title: 'Confirmez le mot de passe', input: '', ph: 'Mot de passe de sauvegarde', ok: 'Créer', pw: 'txt' });
  if (pw2 !== pw) return toast('Les deux mots de passe sont différents', 3000);
  toast('Préparation de la sauvegarde…', 4000);
  const mine = new Set(ITEMS.map(i => i.id)), key = await wrap(KEY, 'bak:' + pw), rows = (await tx('items', 'readonly', s => s.getAll())).filter(r => mine.has(r.id));
  const parts = [], head = { v: 2, date: Date.now(), key: { salt: b64(key.salt), iv: b64(key.iv), w: b64(key.w), it: key.it }, items: [] };
  for (const r of rows) {
    const b = await tx('blobs', 'readonly', s => s.get(r.id)); if (!b) continue;
    head.items.push({ id: r.id, miv: b64(r.iv), m: b64(r.data), biv: b64(b.iv), len: b.data.byteLength });
    parts.push(b.data);
  }
  const hb = enc.encode(JSON.stringify(head)), len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, hb.length);
  const blob = new Blob([enc.encode('COFFRE2'), len, hb, ...parts], { type: 'application/octet-stream' });
  const name = 'sauvegarde-' + new Date().toISOString().slice(0, 10) + '.coffre';
  const u = URL.createObjectURL(blob), a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 120000);
  toast('Sauvegarde enregistrée dans vos Téléchargements ✅', 3500);
};
$('#r_res').onclick = () => { pickerOpen = true; $('#rin').value = ''; $('#rin').click(); };
$('#rin').onchange = async e => {
  pickerOpen = false;
  const f = e.target.files[0]; if (!f) return;
  try {
    const buf = await f.arrayBuffer(), u8 = new Uint8Array(buf);
    const magic = dec.decode(u8.subarray(0, 7)); if (magic !== 'COFFRE1' && magic !== 'COFFRE2') throw new Error('format');
    const hl = new DataView(buf, 7, 4).getUint32(0), head = JSON.parse(dec.decode(u8.subarray(11, 11 + hl))), v2 = magic === 'COFFRE2';
    const pin = await ask({ title: 'Restaurer la sauvegarde', text: `${head.items.length} fichiers du ${new Date(head.date).toLocaleDateString('fr-BE')}.<br>${v2 ? 'Entrez le mot de passe de cette sauvegarde :' : 'Entrez le code utilisé au moment de cette sauvegarde :'}`, input: '', ph: v2 ? 'Mot de passe' : '••••', ok: 'Restaurer', pw: v2 ? 'txt' : true });
    if (pin === null) return;
    let bk; try { bk = await unwrap(recOf(head.key), v2 ? 'bak:' + pin : pin); } catch (err) { return toast(v2 ? 'Mot de passe incorrect' : 'Code incorrect pour cette sauvegarde'); }
    const have = new Set(ITEMS.map(i => i.id)); let off = 11 + hl, n = 0;
    $('#bar').classList.remove('hide');
    for (const it of head.items) {
      const data = buf.slice(off, off + it.len); off += it.len;
      $('#bartxt').textContent = `Restauration ${++n} / ${head.items.length}`; $('#barp').style.width = (n / head.items.length * 100) + '%';
      if (have.has(it.id)) continue;
      // déchiffre avec la clé de la sauvegarde, rechiffre avec la clé de ce coffre
      const meta = await decJ(bk, { iv: unb64(it.miv), data: unb64(it.m) });
      const plain = await decB(bk, { iv: unb64(it.biv), data });
      const b = await encB(KEY, plain), m = await encJ(KEY, meta);
      const d1 = await db();
      await new Promise((ok, ko) => { const t = d1.transaction(['items', 'blobs'], 'readwrite'); t.objectStore('blobs').put({ id: it.id, iv: b.iv, data: b.data }); t.objectStore('items').put({ id: it.id, iv: m.iv, data: m.data }); t.oncomplete = ok; t.onerror = () => ko(t.error); });
      ITEMS.push({ id: it.id, ...meta });
    }
    $('#bar').classList.add('hide');
    ITEMS.sort((a, b) => b.added - a.added); render(); show('vault'); sync();
    toast('Sauvegarde restaurée ✅');
  } catch (err) { $('#bar').classList.add('hide'); toast("Ce fichier n'est pas une sauvegarde valide", 3500); }
};


/* =========================================================
   Sauvegarde en ligne automatique (Supabase, espace privé)
   Tout ce qui part en ligne est DÉJÀ chiffré sur le téléphone.
   Dossier en ligne : <id du compte>/key.json, m/<id>.json, b/<id>/<n>
   ========================================================= */
const SB_URL = 'https://vmhznuivhwwfphmypsic.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZtaHpudWl2aHd3ZnBobXlwc2ljIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUyOTY1MDIsImV4cCI6MjExMDg3MjUwMn0.RLH1Wq65QMmkTS9zOrFEovKLOav4vOnVuMOTN656ItU';
const BUCKET = 'coffre', CHUNK = 20 * 1024 * 1024;
let CS = null, syncing = false, syncAgain = false, cloudErr = '';

async function sbAuth(path, body) {
  const r = await fetch(SB_URL + '/auth/v1/' + path, { method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.msg || j.error_description || j.message || ('Erreur ' + r.status)); e.code = j.error_code || j.error || r.status; throw e; }
  return j;
}
function setSession(j) {
  CS = { ...(CS || {}), email: j.user ? j.user.email : CS.email, uid: j.user ? j.user.id : CS.uid, access: j.access_token, refresh: j.refresh_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
}
async function saveCloud() {
  if (!CS || !KEY) return;
  await mset('cloud', await encJ(KEY, { email: CS.email, uid: CS.uid, refresh: CS.refresh, last: CS.last || 0, kv: CS.kv || 1 }));
}
async function loadCloud() {
  const r = await mget('cloud');
  if (!r) { CS = null; cloudBadge(); return; }
  try { CS = { ...(await decJ(KEY, r)), access: null, exp: 0 }; } catch (e) { CS = null; }
  cloudBadge();
}
async function token() {
  if (!CS) throw new Error('hors ligne');
  if (!CS.access || Date.now() > CS.exp - 60000) { setSession(await sbAuth('token?grant_type=refresh_token', { refresh_token: CS.refresh })); await saveCloud(); }
  return CS.access;
}
async function sb(path, opt = {}, retry = true) {
  const r = await fetch(SB_URL + '/storage/v1/' + path, { ...opt, headers: { apikey: SB_KEY, Authorization: 'Bearer ' + await token(), ...(opt.headers || {}) } });
  if (r.status === 401 && retry) { CS.exp = 0; return sb(path, opt, false); }
  if (!r.ok) { const t = await r.text().catch(() => ''); const e = new Error('Stockage ' + r.status + ' ' + t.slice(0, 120)); e.status = r.status; throw e; }
  return r;
}
const put = (name, body, type = 'application/octet-stream') => sb(`object/${BUCKET}/${CS.uid}/${name}`, { method: 'POST', headers: { 'Content-Type': type, 'x-upsert': 'true' }, body });
const getObj = name => sb(`object/authenticated/${BUCKET}/${CS.uid}/${name}`);
const delObjs = names => names.length ? sb(`object/${BUCKET}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: names.map(n => CS.uid + '/' + n) }) }) : null;
async function listAll(prefix) {
  const out = []; let off = 0;
  for (;;) {
    const r = await sb(`object/list/${BUCKET}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefix: CS.uid + '/' + prefix.replace(/\/$/, ''), limit: 1000, offset: off, sortBy: { column: 'name', order: 'asc' } }) });
    const j = await r.json(); out.push(...j.map(x => x.name)); if (j.length < 1000) return out; off += 1000;
  }
}
const keyJson = k => JSON.stringify({ salt: b64(k.salt), iv: b64(k.iv), w: b64(k.w) });
/* Clé en ligne v2 : la clé du coffre est protégée par le MOT DE PASSE du compte (8+ caractères),
   et plus par le code à chiffres. Un code à 4-6 chiffres se casse en quelques minutes si quelqu'un
   récupère le fichier ; un vrai mot de passe, non. */
async function cloudKeyJson(pw) { const r = await wrap(KEY, 'cloud:' + pw); return JSON.stringify({ v: 2, it: r.it, salt: b64(r.salt), iv: b64(r.iv), w: b64(r.w) }); }
const recOf = kr => ({ salt: unb64(kr.salt), iv: unb64(kr.iv), w: unb64(kr.w), it: kr.it || OLD_ITER });
async function cloudUpgrade(pw) { await put('key.json', await cloudKeyJson(pw), 'application/json'); CS.kv = 2; await saveCloud(); }

async function markDirty(id, blob) { if (DECOY) return; if (GD) { const g = (await mget('gdirty')) || []; if (!g.includes(id)) g.push(id); await mset('gdirty', g); if (blob) { const gb = (await mget('gdirtyB')) || []; if (!gb.includes(id)) gb.push(id); await mset('gdirtyB', gb); } } const d = (await mget('dirty')) || []; if (!d.includes(id)) d.push(id); await mset('dirty', d); if (blob) { const b = (await mget('dirtyB')) || []; if (!b.includes(id)) b.push(id); await mset('dirtyB', b); } }
async function pendDel(id) { if (DECOY) return; if (GD) { const g = (await mget('gpendDel')) || []; g.push(id); await mset('gpendDel', g); } if (!(await mget('cloud'))) return; const d = (await mget('pendDel')) || []; d.push(id); await mset('pendDel', d); const di = ((await mget('dirty')) || []).filter(x => x !== id); await mset('dirty', di); }

function cloudBadge(state) {
  const i = $('#cst'); if (!i) return;
  if (!CS && !GD) { i.className = 'off'; i.textContent = '–'; return; }
  state = state || ((CS && cloudErr) || (GD && gErr) ? 'err' : (syncing || gSyncing) ? 'run' : 'ok');
  i.className = state; i.textContent = state === 'ok' ? '✓' : state === 'run' ? '↻' : '!';
}
async function uploadItem(row) {
  const b = await tx('blobs', 'readonly', s => s.get(row.id)); if (!b) return;
  const len = b.data.byteLength, n = Math.max(1, Math.ceil(len / CHUNK));
  for (let i = 0; i < n; i++) { if (!KEY || !CS) throw new Error('verrouillé'); await put(`b/${row.id}/${i}`, b.data.slice(i * CHUNK, (i + 1) * CHUNK)); }
  await put(`m/${row.id}.json`, JSON.stringify({ miv: b64(row.iv), m: b64(row.data), biv: b64(b.iv), len, n }), 'application/json');
}
function sync() { sbSync(); gSync(); }
async function sbSync() {
  if (!CS || !KEY || DECOY) return cloudBadge();
  if (syncing) { syncAgain = true; return; }
  syncing = true; cloudErr = ''; cloudBadge('run'); drawCloud();
  try {
    if (CS.kv !== 2) { const kj = keyJson(await mget('key')); if (CS.kj !== kj) { await put('key.json', kj, 'application/json'); CS.kj = kj; } }
    let pd = (await mget('pendDel')) || [];
    for (const id of [...pd]) {
      const chunks = await listAll(`b/${id}/`);
      await delObjs([`m/${id}.json`, ...chunks.map(c => `b/${id}/${c}`)]);
      pd = pd.filter(x => x !== id); await mset('pendDel', pd);
    }
    const remote = new Set((await listAll('m/')).map(n => n.replace(/\.json$/, '')));
    const dirty = new Set((await mget('dirty')) || []);
    const mine = new Set(ITEMS.map(i => i.id));
    const rows = (await tx('items', 'readonly', s => s.getAll())).filter(r => mine.has(r.id));
    let dB = new Set((await mget('dirtyB')) || []);
    let todo = rows.filter(r => !remote.has(r.id) || dB.has(r.id)), k = 0;
    for (const r of todo) {
      cloudStatus(`Envoi ${++k} / ${todo.length}…`);
      await uploadItem(r); dirty.delete(r.id); dB.delete(r.id); await mset('dirty', [...dirty]); await mset('dirtyB', [...dB]);
    }
    for (const id of [...dirty]) {
      const r = rows.find(x => x.id === id);
      if (r && remote.has(id)) {
        const old = await (await getObj(`m/${id}.json`)).json();
        await put(`m/${id}.json`, JSON.stringify({ ...old, miv: b64(r.iv), m: b64(r.data) }), 'application/json');
      }
      dirty.delete(id); await mset('dirty', [...dirty]);
    }
    CS.last = Date.now(); await saveCloud();
  } catch (e) {
    console.warn('sync', e);
    cloudErr = e.status === 413 ? 'Fichier trop gros pour l’espace en ligne' : /fetch|network|Failed/i.test(e.message) ? 'Pas de connexion internet' : e.message;
  } finally {
    syncing = false; cloudStatus(''); cloudBadge(); drawCloud();
    if (syncAgain && KEY && CS) { syncAgain = false; setTimeout(sbSync, 500); }
  }
}
let cMsg = '';
function cloudStatus(t) { cMsg = t; drawCloud(); }
function drawCloud() {
  if (!$('#c_state')) return;
  const on = !!CS;
  $('#c_on').classList.toggle('hide', on);
  ['c_now', 'c_pull', 'c_off', 'c_del'].forEach(i => $('#' + i).classList.toggle('hide', !on));
  $('#c_up').classList.toggle('hide', !on || CS.kv === 2);
  $('#c_box').classList.toggle('on', on && !cloudErr);
  $('#c_box .ci').textContent = !on ? '☁️' : cMsg ? '⏳' : cloudErr ? '⚠️' : '✅';
  $('#c_state').textContent = !on ? 'Désactivée' : cMsg ? 'Synchronisation…' : cloudErr ? 'Problème de synchronisation' : 'Activée';
  $('#c_last').textContent = !on ? 'Activez-la pour ne rien perdre si vous changez de téléphone.'
    : cMsg ? cMsg
    : cloudErr ? cloudErr
    : CS.email + (CS.last ? ' · dernière synchro à ' + new Date(CS.last).toLocaleTimeString('fr-BE', { hour: '2-digit', minute: '2-digit' }) : '');
}
$('#bcloud').onclick = () => { if (GD && !gLive() && !DECOY) return gReconnect(); $('#bset').click(); };
window.addEventListener('online', () => sync());
setInterval(() => { if (KEY && (CS || GD) && !syncing && !gSyncing) sync(); }, 10 * 60000);

/* Fenêtre e-mail + mot de passe */
function askLogin(title, text) {
  return new Promise(res => {
    modal(`<h3>${title}</h3><p>${text}</p><input id="le" type="email" placeholder="Adresse e-mail" autocomplete="username"><input id="lp" type="password" placeholder="Mot de passe (8 caractères min.)" autocomplete="current-password"><div class="msg" id="lm" style="margin:-4px 0 10px"></div><div class="btns"><button id="mno">Annuler</button><button id="mok" class="p">Continuer</button></div>`);
    setTimeout(() => $('#le').focus(), 50);
    $('#mno').onclick = () => { closeModal(); res(null); };
    $('#mok').onclick = async () => {
      const email = $('#le').value.trim(), pw = $('#lp').value;
      if (!/^\S+@\S+\.\S+$/.test(email)) return $('#lm').textContent = 'Adresse e-mail invalide';
      if (pw.length < 8) return $('#lm').textContent = 'Mot de passe : 8 caractères minimum';
      $('#mok').textContent = '…'; $('#lm').textContent = '';
      try { const j = await login(email, pw); j._pw = pw; res(j); closeModal(); }
      catch (e) { $('#mok').textContent = 'Continuer'; $('#lm').textContent = e.message; }
    };
  });
}
async function login(email, pw) {
  try { return await sbAuth('token?grant_type=password', { email, password: pw }); }
  catch (e) {
    if (!/invalid|credentials/i.test(e.code + e.message)) throw new Error(/fetch|Failed/i.test(e.message) ? 'Pas de connexion internet' : e.message);
    // pas encore de compte : on le crée (seul le tout premier compte est accepté)
    try { await sbAuth('signup', { email, password: pw }); }
    catch (e2) { throw new Error(/ferm|propriétaire|Database error/i.test(e2.message) ? 'E-mail ou mot de passe incorrect' : e2.message); }
    return await sbAuth('token?grant_type=password', { email, password: pw });
  }
}

/* Activer depuis un coffre existant */
$('#c_on').onclick = async () => {
  if (DECOY) return toast('Pas de connexion internet', 2500);
  const j = await askLogin('Activer la sauvegarde en ligne', "Créez votre compte de sauvegarde (ou connectez-vous s'il existe déjà). Notez bien ce mot de passe : il vous servira sur un nouveau téléphone.");
  if (!j) return;
  setSession(j);
  // ce compte contient-il déjà un AUTRE coffre ?
  try {
    const ms = await listAll('m/');
    if (ms.length) {
      const one = await (await getObj('m/' + ms[0])).json();
      try { await decJ(KEY, { iv: unb64(one.miv), data: unb64(one.m) }); }
      catch (e) { CS = null; return ask({ title: 'Un autre coffre existe en ligne', text: "Ce compte contient déjà un coffre créé avec un autre code. Pour le récupérer, utilisez « J'ai déjà un coffre sauvegardé en ligne » après « Tout effacer », ou supprimez d'abord cette sauvegarde en ligne.", ok: 'OK', cancel: '' }); }
    }
  } catch (e) {}
  try { await cloudUpgrade(j._pw); } catch (e) { CS = null; return toast('Échec : ' + e.message, 4000); }
  cloudBadge(); drawCloud();
  toast('Sauvegarde en ligne activée ☁️'); sync();
};
$('#c_now').onclick = () => sync();
$('#r_galdel').onclick = () => { if (DECOY) return toast('Indisponible pour le moment', 2500); galDel(); };
async function askUpgrade() {
  const pw = await ask({ title: 'Renforcer la sauvegarde', text: `Tapez le mot de passe de votre compte de sauvegarde (<b>${esc(CS.email)}</b>). Il protégera désormais la clé de votre coffre en ligne, à la place du code à chiffres.`, input: '', ph: 'Mot de passe', ok: 'Renforcer', pw: 'txt' });
  if (pw === null) return;
  try { await sbAuth('token?grant_type=password', { email: CS.email, password: pw }); }
  catch (e) { return toast(/fetch|Failed/i.test(e.message) ? 'Pas de connexion internet' : 'Mot de passe incorrect', 3500); }
  try { await cloudUpgrade(pw); drawCloud(); toast('Sauvegarde renforcée ✅'); } catch (e) { toast('Échec : ' + e.message, 4000); }
}
$('#c_up').onclick = askUpgrade;
$('#c_off').onclick = async () => {
  const ok = await ask({ title: 'Se déconnecter ?', text: 'Les nouveaux fichiers ne seront plus sauvegardés en ligne. Ce qui est déjà en ligne est conservé.', ok: 'Se déconnecter', danger: true });
  if (!ok) return;
  await tx('meta', 'readwrite', s => s.delete('cloud')); CS = null; cloudBadge(); drawCloud();
};
$('#c_del').onclick = async () => {
  const v = await ask({ title: 'Supprimer la sauvegarde en ligne ?', text: 'Tous les fichiers sauvegardés en ligne seront effacés (ceux de ce téléphone restent). Tapez <b>EFFACER</b> pour confirmer.', input: '', ph: 'EFFACER', ok: 'Supprimer', danger: true });
  if (!v || v.trim().toUpperCase() !== 'EFFACER') return;
  try {
    cloudStatus('Suppression…');
    const ms = await listAll('m/'), all = ['key.json', ...ms.map(m => 'm/' + m)];
    for (const m of ms) { const id = m.replace(/\.json$/, ''); (await listAll(`b/${id}/`)).forEach(c => all.push(`b/${id}/${c}`)); }
    for (let i = 0; i < all.length; i += 500) await delObjs(all.slice(i, i + 500));
    await tx('meta', 'readwrite', s => s.delete('cloud')); CS = null; cloudStatus(''); cloudBadge(); drawCloud();
    toast('Sauvegarde en ligne supprimée');
  } catch (e) { cloudStatus(''); toast('Échec : ' + e.message, 4000); }
};

/* Télécharger les fichiers en ligne absents de ce téléphone */
async function pullMissing(showBar = true) {
  const ms = await listAll('m/');
  const have = new Set((await tx('items', 'readonly', s => s.getAllKeys())));
  const todo = ms.map(m => m.replace(/\.json$/, '')).filter(id => !have.has(id));
  let n = 0, bad = 0;
  if (showBar && todo.length) $('#bar').classList.remove('hide');
  for (const id of todo) {
    $('#bartxt').textContent = `Récupération ${++n} / ${todo.length}`; $('#barp').style.width = (n / todo.length * 100) + '%';
    try {
      const o = await (await getObj(`m/${id}.json`)).json();
      const meta = await decJ(KEY, { iv: unb64(o.miv), data: unb64(o.m) });   // vérifie que c'est bien notre coffre
      const parts = []; for (let i = 0; i < o.n; i++) parts.push(await (await getObj(`b/${id}/${i}`)).arrayBuffer());
      const data = await new Blob(parts).arrayBuffer();
      const d1 = await db();
      await new Promise((ok, ko) => { const t = d1.transaction(['items', 'blobs'], 'readwrite'); t.objectStore('blobs').put({ id, iv: unb64(o.biv), data }); t.objectStore('items').put({ id, iv: unb64(o.miv), data: unb64(o.m) }); t.oncomplete = ok; t.onerror = () => ko(t.error); });
      ITEMS.push({ id, ...meta });
    } catch (e) { bad++; console.warn(e); }
  }
  $('#bar').classList.add('hide');
  ITEMS.sort((a, b) => b.added - a.added); render();
  return { got: todo.length - bad, bad };
}
$('#c_pull').onclick = async () => {
  try { cloudStatus('Recherche…'); const r = await pullMissing(); cloudStatus(''); show('vault'); toast(r.got ? `${r.got} fichier(s) récupéré(s) ✅` : 'Rien à récupérer : tout est déjà là'); }
  catch (e) { cloudStatus(''); toast('Échec : ' + e.message, 4000); }
};

/* Nouveau téléphone : récupérer tout le coffre */
$('#srest').onclick = () => sheet('Où est votre sauvegarde ?', [
  { v: 'g', ico: '🗂', cls: 'y', label: 'Google Drive', sub: 'Connexion avec votre compte Google' },
  { v: 's', ico: '☁️', cls: 'b', label: 'Compte de sauvegarde', sub: 'E-mail et mot de passe' }
], v => { if (v === 'g') gRestore(); else if (v === 's') setTimeout(sbRestore, 50); });
async function sbRestore() {
  const j = await askLogin('Récupérer mon coffre', "Connectez-vous avec le compte de sauvegarde que vous aviez créé.");
  if (!j) return;
  setSession(j);
  let kr;
  try { kr = await (await getObj('key.json')).json(); }
  catch (e) { CS = null; return ask({ title: 'Aucun coffre en ligne', text: "Ce compte ne contient pas encore de coffre sauvegardé.", ok: 'OK', cancel: '' }); }
  const rec = recOf(kr);
  if (kr.v === 2) {
    try { KEY = await unwrap(rec, 'cloud:' + j._pw); } catch (e) { CS = null; return ask({ title: 'Impossible d’ouvrir', text: 'Le mot de passe ne correspond pas à la sauvegarde.', ok: 'OK', cancel: '' }); }
    // nouveau téléphone : on choisit le code de ce téléphone
    let pin = null;
    while (pin === null) {
      const p1 = await ask({ title: 'Code de ce téléphone', text: 'Choisissez le code secret (6 à 12 chiffres) pour ouvrir le coffre sur ce téléphone :', input: '', ph: '••••••', ok: 'Suivant', pw: true, cancel: '' });
      if (!/^\d{6,12}$/.test(p1 || '')) { toast('Le code doit faire 6 à 12 chiffres'); continue; }
      const p2 = await ask({ title: 'Confirmez le code', input: '', ph: '••••••', ok: 'Valider', pw: true, cancel: '' });
      if (p2 === p1) pin = p1; else toast('Les deux codes sont différents');
    }
    await mset('key', await wrap(KEY, pin)); CS.kv = 2;
  } else {
    for (let tries = 0; tries < 5; tries++) {
      const pin = await ask({ title: 'Code du coffre', text: tries ? 'Code incorrect. Réessayez :' : 'Entrez le code secret de votre coffre :', input: '', ph: '••••', ok: 'Ouvrir', pw: true });
      if (pin === null) { CS = null; return; }
      try { KEY = await unwrap(rec, pin); await mset('key', await wrap(KEY, pin)); break; } catch (e) { KEY = null; }
    }
    if (!KEY) { CS = null; return toast('Trop d’essais'); }
    try { await cloudUpgrade(j._pw); } catch (e) {}
  }
  DECOY = false; CFG.mode = sMode; await mset('cfg', CFG);
  await saveCloud();
  ITEMS = []; render(); show('vault');
  try { const r = await pullMissing(); toast(`${r.got} fichier(s) récupéré(s) ✅`, 3000); }
  catch (e) { toast('Récupération interrompue : ' + e.message, 4000); }
  await openVault();
  if (CFG.mode === 'calc') ask({ title: 'Coffre récupéré ✅', text: "Pour l'ouvrir à l'avenir : <b>tapez votre code dans « Rechercher »</b> du bloc-notes.", ok: 'OK', cancel: '' });
};

/* =========================================================
   Sauvegarde automatique Google Drive
   Les fichiers vont dans le dossier CACHÉ de l'appli sur Drive (invisible dans la liste
   de vos fichiers Drive). Tout part déjà chiffré. La clé du coffre y est protégée par un
   « mot de passe de sauvegarde Drive » (jamais par le code à chiffres).
   ========================================================= */
const GCLIENT_DEFAULT = '11261545131-pecqmde6k1e01nbdrdrsgnu3our8qf4e.apps.googleusercontent.com';   // identifiant OAuth Google (public, ce n'est pas un secret)
const GSCOPE = 'https://www.googleapis.com/auth/drive.appdata', GAPI = 'https://www.googleapis.com';
let GD = null, gTok = null, gExp = 0, gSyncing = false, gAgain = false, gErr = '', gMsg = '';
const gClient = () => (CFG.gcid || GCLIENT_DEFAULT).trim();
const gRedirect = () => location.origin + location.pathname.replace(/[^/]*$/, '') + 'oauth.html';
const gLive = () => !!gTok && Date.now() < gExp;
const AUTHMSG = 'Touchez le nuage ☁️ pour reconnecter Google Drive';

/* Connexion Google : à appeler pendant un toucher (sinon le téléphone bloque la fenêtre) */
function gAuth() {
  return new Promise((ok, ko) => {
    if (!gClient()) return ko(new Error('noclient'));
    const st = b64(rnd(18)).replace(/[^a-z0-9]/gi, '');
    const q = { client_id: gClient(), redirect_uri: gRedirect(), response_type: 'token', scope: GSCOPE, state: st, include_granted_scopes: 'true' };
    if (GD && GD.email) q.login_hint = GD.email;
    let done = false, bc = null;
    const fin = (err, v) => { if (done) return; done = true; try { bc && bc.close(); } catch (e) {} window.removeEventListener('message', onMsg); clearTimeout(to); setTimeout(() => pickerOpen = false, 1500); err ? ko(err) : ok(v); };
    const got = d => { if (!d || d.state !== st) return; if (d.error || !d.token) return fin(new Error(d.error || 'refus')); gTok = d.token; gExp = Date.now() + (d.exp - 120) * 1000; fin(null, gTok); };
    try { bc = new BroadcastChannel('notes-oauth'); bc.onmessage = e => got(e.data); } catch (e) {}
    const onMsg = e => { if (e.origin === location.origin) got(e.data); };
    window.addEventListener('message', onMsg);
    const to = setTimeout(() => fin(new Error('timeout')), 240000);
    pickerOpen = true;
    const w = window.open('https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams(q), 'notes_google');
    if (!w) fin(new Error('popup'));
  });
}
async function gfetch(path, opt = {}) {
  if (!gLive()) throw Object.assign(new Error(AUTHMSG), { auth: 1 });
  const r = await fetch(GAPI + path, { ...opt, headers: { Authorization: 'Bearer ' + gTok, ...(opt.headers || {}) } });
  if (r.status === 401) { gTok = null; throw Object.assign(new Error(AUTHMSG), { auth: 1 }); }
  if (!r.ok) { const t = await r.text().catch(() => ''); const e = new Error('Drive ' + r.status + ' ' + t.slice(0, 140)); e.status = r.status; throw e; }
  return r;
}
async function gList() {
  const out = {}; let pt = '';
  do {
    const p = { spaces: 'appDataFolder', fields: 'nextPageToken,files(id,name)', pageSize: '1000' }; if (pt) p.pageToken = pt;
    const j = await (await gfetch('/drive/v3/files?' + new URLSearchParams(p))).json();
    (j.files || []).forEach(f => out[f.name] = f.id); pt = j.nextPageToken;
  } while (pt);
  return out;
}
async function gPut(name, body, type, map) {
  const id = map[name];
  if (id) { await gfetch(`/upload/drive/v3/files/${id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': type }, body }); return id; }
  const r = await gfetch('/upload/drive/v3/files?uploadType=resumable&fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': type }, body: JSON.stringify({ name, parents: ['appDataFolder'] }) });
  const loc = r.headers.get('Location');
  let j;
  if (loc) {
    const u = await fetch(loc, { method: 'PUT', headers: { 'Content-Type': type }, body });
    if (!u.ok) { const e = new Error('Drive envoi ' + u.status); e.status = u.status; throw e; }
    j = await u.json();
  } else {   // secours : création puis contenu
    j = await (await gfetch('/drive/v3/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, parents: ['appDataFolder'] }) })).json();
    await gfetch(`/upload/drive/v3/files/${j.id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': type }, body });
  }
  map[name] = j.id; return j.id;
}
const gGet = id => gfetch(`/drive/v3/files/${id}?alt=media`);
const gDel = id => gfetch(`/drive/v3/files/${id}`, { method: 'DELETE' }).catch(e => { if (e.status !== 404) throw e; });

async function saveDrive() { if (GD && KEY && !DECOY) await mset('gdrive', await encJ(KEY, GD)); }
async function loadDrive() { const r = await mget('gdrive'); GD = null; if (r) { try { GD = await decJ(KEY, r); } catch (e) {} } }
async function gMetaJson(r) { const b = await tx('blobs', 'readonly', s => s.get(r.id)); return JSON.stringify({ miv: b64(r.iv), m: b64(r.data), biv: b64(b.iv), len: b.data.byteLength }); }

async function gSync() {
  if (!GD || !KEY || DECOY) return;
  if (gSyncing) { gAgain = true; return; }
  if (!gLive()) { gErr = AUTHMSG; cloudBadge(); drawDrive(); return; }
  gSyncing = true; gErr = ''; cloudBadge('run'); drawDrive();
  try {
    const map = await gList();
    let pd = (await mget('gpendDel')) || [];
    for (const id of [...pd]) {
      for (const n of [`m_${id}.json`, `b_${id}`]) if (map[n]) { await gDel(map[n]); delete map[n]; }
      pd = pd.filter(x => x !== id); await mset('gpendDel', pd);
    }
    const mine = new Set(ITEMS.map(i => i.id));
    const rows = (await tx('items', 'readonly', s => s.getAll())).filter(r => mine.has(r.id));
    const dB = new Set((await mget('gdirtyB')) || []), dM = new Set((await mget('gdirty')) || []);
    const todo = rows.filter(r => !map[`m_${r.id}.json`] || !map[`b_${r.id}`] || dB.has(r.id));
    let k = 0;
    for (const r of todo) {
      if (!KEY || !GD) throw new Error('verrouillé');
      gStatus(`Envoi vers Drive ${++k} / ${todo.length}…`);
      const b = await tx('blobs', 'readonly', s => s.get(r.id)); if (!b) continue;
      await gPut(`b_${r.id}`, b.data, 'application/octet-stream', map);   // le contenu d'abord…
      await gPut(`m_${r.id}.json`, await gMetaJson(r), 'application/json', map);   // …puis la fiche
      dB.delete(r.id); dM.delete(r.id); await mset('gdirtyB', [...dB]); await mset('gdirty', [...dM]);
    }
    for (const id of [...dM]) {
      const r = rows.find(x => x.id === id);
      if (r && map[`m_${id}.json`]) await gPut(`m_${id}.json`, await gMetaJson(r), 'application/json', map);
      dM.delete(id); await mset('gdirty', [...dM]);
    }
    GD.last = Date.now(); await saveDrive();
  } catch (e) {
    console.warn('drive', e);
    gErr = e.auth ? AUTHMSG : e.status === 403 && /quota|storage/i.test(e.message) ? 'Google Drive est plein' : /fetch|network|Failed/i.test(e.message) ? 'Pas de connexion internet' : e.message;
  } finally {
    gSyncing = false; gStatus(''); cloudBadge();
    if (gAgain && KEY && GD) { gAgain = false; setTimeout(gSync, 500); }
  }
}
function gStatus(t) { gMsg = t; drawDrive(); }
function drawDrive() {
  if (!$('#g_state')) return;
  const on = !!GD;
  $('#g_on').classList.toggle('hide', on);
  ['g_now', 'g_pull', 'g_off'].forEach(i => $('#' + i).classList.toggle('hide', !on));
  $('#g_box').classList.toggle('on', on && !gErr);
  $('#g_box .ci').textContent = !on ? '🗂' : gMsg ? '⏳' : gErr ? '⚠️' : '✅';
  $('#g_state').textContent = !on ? 'Désactivée' : gMsg ? 'Synchronisation…' : gErr ? 'À reconnecter' : 'Activée';
  $('#g_last').textContent = !on ? 'Sauvegarde automatique et cachée dans votre Google Drive (15 Go gratuits).'
    : gMsg ? gMsg : gErr ? gErr
    : (GD.email || 'Google Drive') + (GD.last ? ' · dernière synchro à ' + new Date(GD.last).toLocaleTimeString('fr-BE', { hour: '2-digit', minute: '2-digit' }) : '');
  $('#g_cidv').textContent = gClient() ? 'Configuré' : 'À configurer';
}
/* Reconnexion (toucher le nuage, ou automatiquement juste après l'ouverture du coffre) */
async function gReconnect() {
  try { await gAuth(); gErr = ''; drawDrive(); gSync(); return true; }
  catch (e) { gErr = e.message === 'popup' ? 'Fenêtre bloquée : touchez le nuage ☁️' : AUTHMSG; cloudBadge(); drawDrive(); return false; }
}
async function askDrivePw(confirm) {
  const p1 = await ask({ title: 'Mot de passe de sauvegarde Drive', text: confirm ? 'Choisissez un mot de passe (8 caractères minimum). Il protège la clé de votre coffre sur Drive et vous sera demandé sur un nouveau téléphone. <b>Notez-le bien.</b>' : 'Entrez le mot de passe de sauvegarde Drive :', input: '', ph: 'Mot de passe', ok: confirm ? 'Suivant' : 'Ouvrir', pw: 'txt' });
  if (p1 === null) return null;
  if (p1.length < 8) { toast('8 caractères minimum', 3000); return null; }
  if (!confirm) return p1;
  const p2 = await ask({ title: 'Confirmez le mot de passe', input: '', ph: 'Mot de passe', ok: 'Continuer avec Google', pw: 'txt' });
  if (p2 !== p1) { toast('Les deux mots de passe sont différents', 3000); return null; }
  return p1;
}
async function gEmail() { try { return (await (await gfetch('/drive/v3/about?fields=user(emailAddress)')).json()).user.emailAddress; } catch (e) { return ''; } }
const gKeyJson = async pw => { const r = await wrap(KEY, 'gdrive:' + pw); return JSON.stringify({ v: 2, it: r.it, salt: b64(r.salt), iv: b64(r.iv), w: b64(r.w) }); };

async function gSetupClient() {
  const v = await ask({ title: 'Identifiant Google', text: `Collez l'« ID client » créé dans Google Cloud.<br><br>Adresse de retour à déclarer :<br><b style="word-break:break-all">${esc(gRedirect())}</b>`, input: CFG.gcid || '', ph: '…apps.googleusercontent.com', ok: 'Enregistrer' });
  if (v === null) return false;
  if (v.trim() && !/\.apps\.googleusercontent\.com$/.test(v.trim())) { toast('Cet identifiant ne semble pas correct', 3500); return false; }
  CFG.gcid = v.trim(); await mset('cfg', CFG); drawDrive(); return !!gClient();
}
$('#g_cid').onclick = async () => {
  const v = await sheet('Réglage Google Drive', [{ v: 'copy', ico: '📋', cls: 'b', label: 'Copier l’adresse de retour', sub: gRedirect() }, { v: 'id', ico: '🔑', cls: 'gr', label: 'Identifiant Google (ID client)', sub: gClient() || 'Pas encore configuré' }]);
  if (v === 'copy') { try { await navigator.clipboard.writeText(gRedirect()); toast('Adresse copiée ✅'); } catch (e) { toast(gRedirect(), 6000); } }
  else if (v === 'id') gSetupClient();
};
$('#g_on').onclick = async () => {
  if (DECOY) return toast('Pas de connexion internet', 2500);
  if (!gClient() && !(await gSetupClient())) return;
  const pw = await askDrivePw(true); if (!pw) return;
  try { await gAuth(); } catch (e) { return toast(e.message === 'popup' ? 'Fenêtre Google bloquée : réessayez' : 'Connexion Google annulée', 3500); }
  try {
    gStatus('Préparation…');
    const map = await gList();
    if (map['key.json']) {   // un coffre existe déjà sur ce Drive : est-ce le même ?
      let same = false;
      try { const kr = await (await gGet(map['key.json'])).json(); const k = await unwrap(recOf(kr), 'gdrive:' + pw); same = b64(await crypto.subtle.exportKey('raw', k)) === b64(await crypto.subtle.exportKey('raw', KEY)); } catch (e) {}
      if (!same) { gStatus(''); return ask({ title: 'Un autre coffre est sur ce Drive', text: "Ce compte Google contient déjà un coffre (ou un autre mot de passe). Pour le récupérer : « Tout effacer », puis « J'ai déjà un coffre sauvegardé en ligne » → Google Drive.", ok: 'OK', cancel: '' }); }
    }
    await gPut('key.json', await gKeyJson(pw), 'application/json', map);
    GD = { email: await gEmail(), last: 0 }; await saveDrive();
    await mset('gdirty', []); await mset('gdirtyB', []); await mset('gpendDel', []);
    gStatus(''); toast('Google Drive activé ☁️'); gSync();
  } catch (e) { gStatus(''); GD = null; toast('Échec : ' + e.message, 4000); }
};
$('#g_now').onclick = () => gLive() ? gSync() : gReconnect();
$('#g_pull').onclick = async () => {
  if (!gLive() && !(await gReconnect())) return;
  try { gStatus('Recherche…'); const r = await gPullMissing(); gStatus(''); show('vault'); toast(r.got ? `${r.got} fichier(s) récupéré(s) ✅` : 'Rien à récupérer : tout est déjà là'); }
  catch (e) { gStatus(''); toast('Échec : ' + e.message, 4000); }
};
$('#g_off').onclick = async () => {
  const v = await sheet('Google Drive', [{ v: 'off', ico: '⏏', cls: 'gr', label: 'Déconnecter', sub: 'La sauvegarde déjà sur Drive est conservée' }, { v: 'del', ico: '🗑', cls: 'r', label: 'Supprimer la sauvegarde Drive', sub: 'Efface tout le coffre de Google Drive', dg: true }]);
  if (v === 'off') { await tx('meta', 'readwrite', s => s.delete('gdrive')); GD = null; gTok = null; gErr = ''; cloudBadge(); drawDrive(); toast('Google Drive déconnecté'); }
  else if (v === 'del') {
    const c = await ask({ title: 'Supprimer la sauvegarde Drive ?', text: 'Tapez <b>EFFACER</b> pour confirmer.', input: '', ph: 'EFFACER', ok: 'Supprimer', danger: true });
    if (!c || c.trim().toUpperCase() !== 'EFFACER') return;
    if (!gLive() && !(await gReconnect())) return;
    try { gStatus('Suppression…'); const map = await gList(); for (const id of Object.values(map)) await gDel(id); await tx('meta', 'readwrite', s => s.delete('gdrive')); GD = null; gErr = ''; gStatus(''); cloudBadge(); toast('Sauvegarde Drive supprimée'); }
    catch (e) { gStatus(''); toast('Échec : ' + e.message, 4000); }
  }
};
async function gPullMissing() {
  const map = await gList(), have = new Set(await tx('items', 'readonly', s => s.getAllKeys()));
  const todo = Object.keys(map).filter(n => /^m_.+\.json$/.test(n)).map(n => n.slice(2, -5)).filter(id => !have.has(id) && map[`b_${id}`]);
  let n = 0, bad = 0;
  if (todo.length) $('#bar').classList.remove('hide');
  for (const id of todo) {
    $('#bartxt').textContent = `Récupération ${++n} / ${todo.length}`; $('#barp').style.width = (n / todo.length * 100) + '%';
    try {
      const o = await (await gGet(map[`m_${id}.json`])).json();
      const meta = await decJ(KEY, { iv: unb64(o.miv), data: unb64(o.m) });
      const data = await (await gGet(map[`b_${id}`])).arrayBuffer();
      const d1 = await db();
      await new Promise((ok, ko) => { const t = d1.transaction(['items', 'blobs'], 'readwrite'); t.objectStore('blobs').put({ id, iv: unb64(o.biv), data }); t.objectStore('items').put({ id, iv: unb64(o.miv), data: unb64(o.m) }); t.oncomplete = ok; t.onerror = () => ko(t.error); });
      ITEMS.push({ id, ...meta });
    } catch (e) { bad++; console.warn(e); }
  }
  $('#bar').classList.add('hide');
  ITEMS.sort((a, b) => b.added - a.added); render();
  return { got: todo.length - bad, bad };
}
/* Nouveau téléphone : récupérer le coffre depuis Google Drive */
async function gRestore() {
  if (!gClient() && !(await gSetupClient())) return;
  try { await gAuth(); } catch (e) { return toast(e.message === 'popup' ? 'Fenêtre Google bloquée : réessayez' : 'Connexion Google annulée', 3500); }
  let map, kr;
  try { map = await gList(); if (!map['key.json']) throw 0; kr = await (await gGet(map['key.json'])).json(); }
  catch (e) { return ask({ title: 'Aucun coffre sur ce Drive', text: 'Ce compte Google ne contient pas de coffre sauvegardé.', ok: 'OK', cancel: '' }); }
  for (let tries = 0; tries < 5 && !KEY; tries++) {
    const pw = await askDrivePw(false); if (pw === null) return;
    try { KEY = await unwrap(recOf(kr), 'gdrive:' + pw); } catch (e) { KEY = null; toast('Mot de passe incorrect', 2500); }
  }
  if (!KEY) return;
  let pin = null;
  while (pin === null) {
    const p1 = await ask({ title: 'Code de ce téléphone', text: 'Choisissez le code secret (6 à 12 chiffres) pour ouvrir le coffre sur ce téléphone :', input: '', ph: '••••••', ok: 'Suivant', pw: true, cancel: '' });
    if (!/^\d{6,12}$/.test(p1 || '')) { toast('Le code doit faire 6 à 12 chiffres'); continue; }
    const p2 = await ask({ title: 'Confirmez le code', input: '', ph: '••••••', ok: 'Valider', pw: true, cancel: '' });
    if (p2 === p1) pin = p1; else toast('Les deux codes sont différents');
  }
  DECOY = false;
  await mset('key', await wrap(KEY, pin)); CFG.mode = sMode; await mset('cfg', CFG);
  GD = { email: await gEmail(), last: Date.now() }; await saveDrive();
  ITEMS = []; render(); show('vault');
  try { const r = await gPullMissing(); toast(`${r.got} fichier(s) récupéré(s) ✅`, 3000); } catch (e) { toast('Récupération interrompue : ' + e.message, 4000); }
  await openVault();
  if (CFG.mode === 'calc') ask({ title: 'Coffre récupéré ✅', text: "Pour l'ouvrir à l'avenir : <b>tapez votre code dans « Rechercher »</b> du bloc-notes.", ok: 'OK', cancel: '' });
}

start();
