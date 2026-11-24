import { Conversation, stripAudioTags } from '@elevenlabs/client';

/* ---------- Claire : assistante vocale personnelle d'Ahmed ---------- */
const AGENT_ID = 'agent_4001m84p4jzxf819h92knvddbfqc';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- données locales (restent sur le téléphone) ---------- */
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('claire_' + k)) ?? d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('claire_' + k, JSON.stringify(v)); } catch (e) {} }
};
let NOTES = store.get('notes', []), RAPPELS = store.get('rappels', []), CONTACTS = store.get('contacts', []);
const save = () => { store.set('notes', NOTES); store.set('rappels', RAPPELS); store.set('contacts', CONTACTS); draw(); };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const fmtDate = t => new Date(t).toLocaleString('fr-BE', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function contactNum(q) {
  const s = String(q || '').trim();
  if (/^[+\d][\d\s./-]{5,}$/.test(s)) return s.replace(/[^\d+]/g, '').replace(/^00/, '+').replace(/^0(?=4)/, '+32');
  const c = CONTACTS.find(c => c.nom.toLowerCase() === s.toLowerCase()) || CONTACTS.find(c => c.nom.toLowerCase().includes(s.toLowerCase()));
  return c ? c.tel : null;
}
function openLink(url) {   // ouvre le téléphone / WhatsApp / l'agenda
  const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove();
}

/* ---------- outils que Claire utilise pendant la conversation ---------- */
const clientTools = {
  ajouter_note: ({ titre, texte }) => { NOTES.unshift({ id: uid(), titre: titre || 'Note', texte: texte || '', t: Date.now() }); save(); toast('Note ajoutée'); return 'Note enregistrée.'; },
  creer_rappel: async ({ quand, texte }) => {
    const t = Date.parse(quand); if (!t) return 'Erreur : date illisible, demande la date et l’heure exactes.';
    if (t < Date.now() - 60000) return 'Erreur : cette heure est déjà passée.';
    const r = { id: uid(), t, texte: texte || 'Rappel', fait: false }; RAPPELS.push(r); RAPPELS.sort((a, b) => a.t - b.t); save();
    try { window.ClaireApp?.reminder(r.id, t, r.texte); } catch (e) {}   // appli Android : rappel même appli fermée
    await askNotif(); toast('Rappel : ' + fmtDate(t));
    return 'Rappel créé pour le ' + fmtDate(t) + '.';
  },
  appeler: ({ numero_ou_nom }) => {
    const n = contactNum(numero_ou_nom);
    if (!n) return 'Erreur : je ne connais pas ce contact. Demande le numéro, ou propose de l’enregistrer dans les contacts de l’appli.';
    setTimeout(() => openLink('tel:' + n), 600); return 'Le téléphone est prêt à appeler ' + n + '.';
  },
  envoyer_whatsapp: ({ numero_ou_nom, message }) => {
    const n = numero_ou_nom ? contactNum(numero_ou_nom) : '';
    if (numero_ou_nom && !n) return 'Erreur : contact inconnu. Demande le numéro ou laisse Ahmed choisir le contact dans WhatsApp.';
    setTimeout(() => openLink('https://wa.me/' + (n || '').replace('+', '') + '?text=' + encodeURIComponent(message || '')), 600);
    return 'WhatsApp est ouvert avec le message prêt. Ahmed doit toucher Envoyer.';
  },
  ajouter_agenda: ({ titre, debut, duree_minutes, lieu }) => {
    const s = Date.parse(debut); if (!s) return 'Erreur : date illisible.';
    const e = s + (duree_minutes || 60) * 60000, z = x => new Date(x).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    setTimeout(() => openLink('https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + encodeURIComponent(titre) + '&dates=' + z(s) + '/' + z(e) + (lieu ? '&location=' + encodeURIComponent(lieu) : '')), 600);
    return 'Google Agenda est ouvert avec le rendez-vous ; Ahmed doit toucher Enregistrer.';
  },
  meteo: async ({ ville }) => {
    try {
      let lat = 50.8503, lon = 4.3517, nom = 'Bruxelles';
      const v = (ville || '').trim();
      if (v && !/^bruxelles|brussel/i.test(v)) {
        const [city, country] = v.split(',').map(s => s.trim());
        const g = await (await fetch('https://geocoding-api.open-meteo.com/v1/search?count=10&language=fr&name=' + encodeURIComponent(city))).json();
        const N = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        const L = (g.results || []).filter(r => !country || N(r.country).includes(N(country)));
        // le nom exact d'abord (Tanger, pas Tangerang), puis la ville la plus peuplée
        L.sort((a, b) => (N(b.name) === N(city)) - (N(a.name) === N(city)) || (b.population || 0) - (a.population || 0));
        const r = L[0]; if (!r) return 'Erreur : ville introuvable (' + v + ').';
        lat = r.latitude; lon = r.longitude; nom = r.name + (r.country ? ', ' + r.country : '');
      }
      const u = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon + '&timezone=auto&forecast_days=7'
        + '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation'
        + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,sunrise,sunset';
      const m = await (await fetch(u)).json();
      const W = c => ({ 0: 'ciel dégagé', 1: 'plutôt dégagé', 2: 'partiellement nuageux', 3: 'couvert', 45: 'brouillard', 48: 'brouillard givrant', 51: 'bruine légère', 53: 'bruine', 55: 'forte bruine', 61: 'pluie faible', 63: 'pluie', 65: 'forte pluie', 66: 'pluie verglaçante', 67: 'pluie verglaçante forte', 71: 'neige faible', 73: 'neige', 75: 'forte neige', 77: 'grains de neige', 80: 'averses', 81: 'averses', 82: 'fortes averses', 85: 'averses de neige', 86: 'fortes averses de neige', 95: 'orage', 96: 'orage avec grêle', 99: 'orage avec forte grêle' }[c] || 'inconnu');
      const d = m.daily;
      return JSON.stringify({
        lieu: nom, maintenant: { temperature: m.current.temperature_2m + '°C', ressenti: m.current.apparent_temperature + '°C', ciel: W(m.current.weather_code), vent: m.current.wind_speed_10m + ' km/h' },
        jours: d.time.map((x, i) => ({ date: new Date(x + 'T12:00').toLocaleDateString('fr-BE', { weekday: 'long', day: 'numeric', month: 'long' }), ciel: W(d.weather_code[i]), min: d.temperature_2m_min[i] + '°C', max: d.temperature_2m_max[i] + '°C', risque_pluie: d.precipitation_probability_max[i] + '%', pluie: d.precipitation_sum[i] + ' mm', vent_max: d.wind_speed_10m_max[i] + ' km/h', lever: d.sunrise[i].slice(11), coucher: d.sunset[i].slice(11) }))
      });
    } catch (e) { return 'Erreur : la météo ne répond pas, réessaie plus tard.'; }
  },
  chercher_wikipedia: async ({ recherche }) => {
    try {
      const s = await (await fetch('https://fr.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*&srlimit=3&srsearch=' + encodeURIComponent(recherche || ''))).json();
      const hits = (s.query && s.query.search) || []; if (!hits.length) return 'Rien trouvé dans Wikipédia pour « ' + recherche + ' ».';
      const out = [];
      for (const h of hits.slice(0, 2)) {
        const r = await (await fetch('https://fr.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(h.title.replace(/ /g, '_')))).json();
        out.push({ titre: r.title, resume: (r.extract || '').slice(0, 1200) });
      }
      return JSON.stringify({ source: 'Wikipédia', resultats: out });
    } catch (e) { return 'Erreur : Wikipédia ne répond pas.'; }
  },
  lire_notes_et_rappels: ({ recherche }) => {
    if (isLocked()) return 'Refusé : le téléphone est verrouillé. Dis à Ahmed de le déverrouiller pour entendre ses notes, rappels et contacts.';
    const q = (recherche || '').toLowerCase(), m = x => !q || JSON.stringify(x).toLowerCase().includes(q);
    return JSON.stringify({
      maintenant: fmtDate(Date.now()),
      notes: NOTES.filter(m).slice(0, 20).map(n => ({ titre: n.titre, texte: n.texte.slice(0, 400), date: fmtDate(n.t) })),
      rappels_a_venir: RAPPELS.filter(r => !r.fait && m(r)).slice(0, 20).map(r => ({ quand: fmtDate(r.t), texte: r.texte })),
      contacts: CONTACTS.filter(m).slice(0, 50).map(c => ({ nom: c.nom, tel: c.tel }))
    });
  }
};

/* ---------- écran verrouillé : Claire répond, mais les notes restent cachées ---------- */
let LOCKED = /[?&]lock=1/.test(location.search);
const isLocked = () => { try { return LOCKED && (window.ClaireApp ? window.ClaireApp.isLocked() : true); } catch (e) { return LOCKED; } };
function setLocked(on) { LOCKED = !!on; document.body.classList.toggle('locked', LOCKED); }
/* ---------- conversation ---------- */
let conv = null, starting = false;
function setState(s, label) {
  document.body.dataset.state = s;
  $('#status').textContent = label;
}
function addMsg(role, text) {
  text = stripAudioTags ? stripAudioTags(text) : text.replace(/\[[^\]]{1,30}\]\s*/g, '');
  if (!text.trim()) return;
  const d = document.createElement('div'); d.className = 'msg ' + role; d.textContent = text;
  const log = $('#log'); log.appendChild(d); while (log.children.length > 30) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
}
async function start() {
  if (conv || starting) return;
  starting = true; stopWake(); setState('connecting', 'Connexion…');
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()));
    conv = await Conversation.startSession({
      agentId: AGENT_ID, connectionType: 'webrtc', clientTools,
      onConnect: () => setState('listening', 'Je t’écoute…'),
      onModeChange: ({ mode }) => setState(mode === 'speaking' ? 'speaking' : 'listening', mode === 'speaking' ? 'Claire parle…' : 'Je t’écoute…'),
      onMessage: m => addMsg(m.role || (m.source === 'ai' ? 'agent' : 'user'), m.message),
      onError: e => { console.warn(e); toast('Problème de connexion'); },
      onDisconnect: () => { conv = null; if (LOCKED) { setLocked(false); try { window.ClaireApp?.done(); } catch (e) {} } setState('idle', wakeOn ? 'Dis « Claire » ou touche le cercle' : 'Touche le cercle pour parler'); if (wakeOn) setTimeout(startWake, 800); }
    });
  } catch (e) {
    console.warn(e); conv = null;
    if (LOCKED) setTimeout(() => { setLocked(false); try { window.ClaireApp?.done(); } catch (x) {} }, 4000);
    setState('idle', e && e.name === 'NotAllowedError' ? 'Autorise le micro pour parler à Claire' : 'Impossible de joindre Claire, réessaie');
    if (wakeOn) setTimeout(startWake, 1500);
  }
  starting = false;
}
async function stop() { const c = conv; conv = null; try { await c?.endSession(); } catch (e) {} }
$('#orb').onclick = () => conv ? stop() : start();

/* ---------- réveil vocal : « Claire » (quand l'appli est ouverte) ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let wakeOn = store.get('wake', false), rec = null;
function startWake() {
  if (IS_APK || !wakeOn || !SR || conv || starting || document.hidden || rec) return;
  rec = new SR(); rec.lang = 'fr-FR'; rec.continuous = true; rec.interimResults = true;
  rec.onresult = ev => {
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const t = ev.results[i][0].transcript.toLowerCase();
      if (/\b(claire|clair|clerc|cler)\b/.test(t)) { stopWake(); start(); return; }
    }
  };
  rec.onerror = e => { if (e.error === 'not-allowed') { wakeOn = false; store.set('wake', false); drawWake(); toast('Micro refusé : réveil vocal coupé'); } };
  rec.onend = () => { rec = null; if (wakeOn && !conv && !starting) setTimeout(startWake, 400); };
  try { rec.start(); setState('wake', 'Dis « Claire » pour me parler'); } catch (e) { rec = null; }
}
function stopWake() { const r = rec; rec = null; if (r) { r.onend = null; try { r.abort(); } catch (e) {} } }
/* dans l'appli Android : réveil vocal permanent (écoute du téléphone, même écran éteint) */
const IS_APK = !!window.ClaireApp || /ClaireApp/.test(navigator.userAgent) || document.referrer.startsWith('android-app://io.github.vander185.claire');
let nativeOn = (() => { try { return window.ClaireApp ? window.ClaireApp.wakeRunning() : store.get('nativeWake', false); } catch (e) { return false; } })();
function drawWake() {
  if (IS_APK) {
    $('#wake').classList.toggle('on', nativeOn);
    $('#wake small').textContent = nativeOn ? 'Toujours à l’écoute de « Claire »' : 'Désactivé';
    return;
  }
  $('#wake').classList.toggle('on', wakeOn);
  $('#wake small').textContent = !SR ? 'Non disponible sur ce navigateur' : wakeOn ? 'Activé quand l’appli est ouverte' : 'Désactivé';
}
$('#wake').onclick = () => {
  if (IS_APK) {
    nativeOn = !nativeOn; store.set('nativeWake', nativeOn); drawWake();
    if (window.ClaireApp) window.ClaireApp.wake(nativeOn);
    else location.href = 'intent://' + (nativeOn ? 'on' : 'off') + '#Intent;scheme=clairewake;package=io.github.vander185.claire;end';
    return;
  }
  if (!SR) { toast('Le réveil vocal demande Chrome'); return; }
  wakeOn = !wakeOn; store.set('wake', wakeOn); drawWake();
  if (wakeOn) startWake(); else { stopWake(); if (!conv) setState('idle', 'Touche le cercle pour parler'); }
};
document.addEventListener('visibilitychange', () => { if (document.hidden) stopWake(); else { startWake(); checkRappels(); if (window.ClaireApp) { try { nativeOn = window.ClaireApp.wakeRunning(); drawWake(); } catch (e) {} } } });

/* ---------- rappels ---------- */
async function askNotif() { try { if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission(); } catch (e) {} }
async function notify(text) {
  try { const r = await navigator.serviceWorker?.ready; if (r && Notification.permission === 'granted') { await r.showNotification('Claire', { body: text, icon: 'icon-192.png', badge: 'icon-192.png', vibrate: [200, 100, 200], tag: 'rappel-' + uid() }); return; } } catch (e) {}
  toast('⏰ ' + text, 8000);
}
function checkRappels() {
  let ch = false;
  RAPPELS.forEach(r => { if (!r.fait && r.t <= Date.now()) { r.fait = true; ch = true; notify(r.texte); try { navigator.vibrate?.([300, 120, 300]); } catch (e) {} } });
  if (ch) save();
}
setInterval(checkRappels, 15000);

/* ---------- affichage : notes, rappels, contacts ---------- */
let tab = 'notes';
function draw() {
  const L = $('#list');
  if (tab === 'notes') L.innerHTML = NOTES.length ? NOTES.map(n => `<div class="it"><b>${esc(n.titre)}</b><p>${esc(n.texte)}</p><em>${fmtDate(n.t)}</em><button class="x" data-k="notes" data-id="${n.id}" aria-label="Supprimer">×</button></div>`).join('') : '<p class="empty">Dis par exemple : « Claire, note que je dois commander les écrans »</p>';
  if (tab === 'rappels') { const R = RAPPELS.filter(r => !r.fait || r.t > Date.now() - 864e5); L.innerHTML = R.length ? R.map(r => `<div class="it${r.fait ? ' done' : ''}"><b>${esc(r.texte)}</b><em>${fmtDate(r.t)}${r.fait ? ' · fait' : ''}</em><button class="x" data-k="rappels" data-id="${r.id}" aria-label="Supprimer">×</button></div>`).join('') : '<p class="empty">Dis par exemple : « Rappelle-moi demain à 9 h d’appeler le garage »</p>'; }
  if (tab === 'contacts') L.innerHTML = `<form id="cf"><input id="cn" placeholder="Nom" autocomplete="off" required><input id="ct" placeholder="Téléphone" inputmode="tel" required><button>Ajouter</button></form>` + (CONTACTS.length ? CONTACTS.map(c => `<div class="it"><b>${esc(c.nom)}</b><em>${esc(c.tel)}</em><button class="x" data-k="contacts" data-id="${c.id}" aria-label="Supprimer">×</button></div>`).join('') : '<p class="empty">Ajoute ici les gens que Claire peut appeler ou à qui elle peut écrire sur WhatsApp.</p>');
  if (tab === 'voix') drawVoix();
  const f = $('#cf'); if (f) f.onsubmit = e => { e.preventDefault(); const tel = contactNum($('#ct').value); if (!tel) { toast('Numéro invalide'); return; } CONTACTS.push({ id: uid(), nom: $('#cn').value.trim(), tel }); CONTACTS.sort((a, b) => a.nom.localeCompare(b.nom, 'fr')); save(); };
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === tab));
  const up = RAPPELS.filter(r => !r.fait).length; $('#nr').textContent = up ? up : '';
}
$('#list').addEventListener('click', e => {
  const b = e.target.closest('.x'); if (!b) return;
  const k = b.dataset.k, id = b.dataset.id;
  if (k === 'notes') NOTES = NOTES.filter(x => x.id !== id);
  if (k === 'rappels') { RAPPELS = RAPPELS.filter(x => x.id !== id); try { window.ClaireApp?.cancelReminder(id); } catch (e) {} }
  if (k === 'contacts') CONTACTS = CONTACTS.filter(x => x.id !== id);
  save();
});
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => { tab = b.dataset.t; draw(); });

let tT; function toast(t, ms = 2600) { const el = $('#toast'); el.textContent = t; el.classList.add('show'); clearTimeout(tT); tT = setTimeout(() => el.classList.remove('show'), ms); }

/* ---------- empreinte vocale (appli Android) ---------- */
const CA = window.ClaireApp;
let vxTimer = null;
function drawVoix() {
  const L = $('#list'); if (!CA) { L.innerHTML = '<p class="empty">Disponible dans l’appli Android Claire.</p>'; return; }
  const p = CA.enrollProgress(), n = CA.enrollTotal(), stored = CA.voiceStored(), strict = CA.isStrict();
  const running = CA.wakeRunning();
  if (p >= 0 && p < n + 1 && p <= n && vxTimer) {
    L.innerHTML = `<div class="vx"><h3>Dites « Claire »</h3><p>Normalement, à votre distance habituelle du téléphone, puis faites une petite pause. Le téléphone vibre à chaque fois que c'est bon.</p><div class="dots">${Array.from({ length: n }, (_, i) => `<i class="${i < p ? 'on' : ''}"></i>`).join('')}</div><p style="text-align:center">${p} / ${n}</p><p style="text-align:center;color:var(--a3)">${esc(CA.enrollMessage ? CA.enrollMessage() : '')}</p><button class="sec" id="vxc">Annuler</button></div>`;
    $('#vxc').onclick = () => { CA.cancelEnroll(); clearInterval(vxTimer); vxTimer = null; drawVoix(); };
    return;
  }
  L.innerHTML = `<div class="vx"><h3>${stored ? '🔒 Claire ne répond qu’à votre voix' : 'Tout le monde peut réveiller Claire'}</h3>
    <p>${stored ? 'Quand quelqu’un d’autre dit « Claire », elle reste silencieuse. Pas parfait à 100 % : sur un seul mot, il peut y avoir des ratés.' : 'Enregistrez votre voix : Claire ne se réveillera plus pour les autres. Tout reste sur le téléphone.'}</p>
    ${running ? `<button class="big" id="vxs">${stored ? 'Réenregistrer ma voix' : 'Enregistrer ma voix'}</button>` : '<p>Activez d’abord « Réveil vocal » en haut à droite.</p>'}
    ${stored ? `<p style="margin-top:4px">Filtre</p><div class="seg"><button data-s="1" class="${strict ? 'on' : ''}">Strict</button><button data-s="0" class="${strict ? '' : 'on'}">Souple</button></div><p style="font-size:12.5px;color:var(--mut)">${strict ? 'Strict : filtre bien les autres voix, vous devrez parfois répéter.' : 'Souple : vous répond presque toujours, filtre moins bien.'}</p><button class="sec" id="vxd">Effacer ma voix</button>` : ''}</div>`;
  const s = $('#vxs'); if (s) s.onclick = () => {
    if (!CA.startEnroll()) { toast('Activez d’abord le réveil vocal'); return; }
    clearInterval(vxTimer); vxTimer = setInterval(() => { const q = CA.enrollProgress(); if (q > n) { clearInterval(vxTimer); vxTimer = null; toast('Voix enregistrée ✓'); } drawVoix(); }, 400);
    setTimeout(drawVoix, 100);
  };
  document.querySelectorAll('.seg button').forEach(b => b.onclick = () => { CA.setStrict(b.dataset.s === '1'); drawVoix(); });
  const d = $('#vxd'); if (d) d.onclick = () => { if (confirm('Effacer votre empreinte vocale ? Tout le monde pourra de nouveau réveiller Claire.')) { CA.clearVoice(); drawVoix(); } };
}
if (CA) $('#tvoix').hidden = false;

/* ---------- démarrage ---------- */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
drawWake(); draw(); checkRappels();
setState('idle', wakeOn ? 'Dis « Claire » ou touche le cercle' : 'Touche le cercle pour parler');
window.claireTalk = lock => { setLocked(lock); if (!conv) start(); };   // appelé par l'appli Android quand on dit « Claire »
setLocked(LOCKED);
if (/[?&]talk=1/.test(location.search)) { history.replaceState(null, '', location.pathname); start(); }   // « Ok Google, ouvre Claire » / raccourci
else startWake();
