/* ==========================================================================
   Bloc-notes : réglages (apparence, notes, scans, données) et finitions
   des fenêtres et des boutons.
   ========================================================================== */
(() => {
'use strict';
const PDEF = { acc: 'or', taille: 'n', apercu: 2, confirm: true, corbeille: 30, ocr: true, nomScan: 'Scan', nomAuto: true };
const P = () => { try { return Object.assign({}, PDEF, JSON.parse(localStorage.getItem('nprefs') || '{}')); } catch (e) { return { ...PDEF }; } };
const Pset = o => { try { localStorage.setItem('nprefs', JSON.stringify(Object.assign(P(), o))); } catch (e) {} appliquer(); };
window.nPrefs = P;
const ACC = {
  or: ['Or', '#e5b400', '#1a1400'], bleu: ['Bleu', '#0a84ff', '#fff'], vert: ['Vert', '#30d158', '#04210f'],
  rose: ['Rose', '#ff375f', '#fff'], violet: ['Violet', '#bf5af2', '#fff'], orange: ['Orange', '#ff9f0a', '#241400'], menthe: ['Menthe', '#63e6e2', '#032221'],
  rouge: ['Rouge', '#ff453a', '#fff'], indigo: ['Indigo', '#5e5ce6', '#fff'], ciel: ['Ciel', '#64d2ff', '#00202e'], emeraude: ['Émeraude', '#00c7a0', '#002119'],
  citron: ['Citron', '#d7f205', '#1c2000'], corail: ['Corail', '#ff7a6b', '#2a0a05'], lavande: ['Lavande', '#b4a7ff', '#150f33'], peche: ['Pêche', '#ffb37a', '#2b1300'],
  sable: ['Sable', '#d4b483', '#241a08'], graphite: ['Graphite', '#aeaeb2', '#111']
};
const TAILLE = { p: ['Petite', 15], n: ['Normale', 17], g: ['Grande', 19], tg: ['Très grande', 22] };

/* la couleur d'accent : toutes les couleurs dorées du bloc-notes passent par une variable */
let converti = new WeakSet();
function convertir() {
  document.querySelectorAll('style').forEach(st => {
    if (converti.has(st)) return; converti.add(st);
    const t = st.textContent;
    if (!/#e5b400|#f5c518/i.test(t)) return;
    st.textContent = t
      .replace(/linear-gradient\(135deg,#f5c518,#e5a300\)/gi, 'var(--acc)')
      .replace(/#e5b400([0-9a-f]{2})\b/gi, (m, a) => `color-mix(in srgb,var(--acc) ${Math.round(parseInt(a, 16) / 2.55)}%,transparent)`)
      .replace(/#e5b400/gi, 'var(--acc)')
      .replace(/color:#1a1400/gi, 'color:var(--acc-txt)');
  });
}
function appliquer() {
  const p = P(), a = ACC[p.acc] || ACC.or, r = document.documentElement.style;
  r.setProperty('--acc', a[1]); r.setProperty('--acc-txt', a[2]);
  r.setProperty('--nfs', TAILLE[p.taille] ? TAILLE[p.taille][1] + 'px' : '17px');
  r.setProperty('--napl', p.apercu);
  document.documentElement.dataset.apercu = p.apercu;
  const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = '#000';
}

/* ---------- finitions : fenêtres, boutons, interrupteurs ---------- */
const css = `
:root{--acc:#e5b400;--acc-txt:#1a1400;--nfs:17px}
#nedit textarea{font-size:var(--nfs)!important;line-height:1.5!important}
#nlist.v-list .ni p{-webkit-line-clamp:var(--napl,2)}
html[data-apercu="0"] #nlist.v-list .ni p{display:none}
/* fenêtres (feuilles du bas) */
.mod{background:#0009;backdrop-filter:blur(10px) saturate(1.2);-webkit-backdrop-filter:blur(10px) saturate(1.2)}
.box{background:linear-gradient(180deg,#1f1f24,#17171b);border-radius:28px 28px 0 0;padding:30px 16px calc(18px + env(safe-area-inset-bottom));box-shadow:0 -10px 40px #000a,inset 0 1px 0 #ffffff1a}
.box:before{top:10px;width:40px;background:#ffffff33}
.box h3{font-size:18px;text-align:center;margin:0 0 14px;font-weight:700;letter-spacing:-.01em}
.box p{text-align:center;color:#a8a8b0}
.box input{border-radius:14px;background:#0c0c0f;border:1.5px solid #ffffff18;font-size:17px;padding:15px 16px}
.box input:focus{border-color:var(--acc);box-shadow:0 0 0 4px color-mix(in srgb,var(--acc) 18%,transparent)}
.btns{gap:10px;margin-top:4px}
.btns button{padding:15px;border-radius:16px;background:#2a2a30;font-size:16px;font-weight:650;transition:transform .12s}
.btns button:active{transform:scale(.97)}
.btns .p{background:var(--acc);color:var(--acc-txt);box-shadow:0 6px 18px color-mix(in srgb,var(--acc) 35%,transparent)}
.sheet h3{text-align:center}
.sheet{display:flex;flex-direction:column}
.sheet .opt{background:#26262c;padding:13px 14px;gap:13px;font-size:16px;font-weight:500}
.sheet .opt:first-of-type{border-radius:16px 16px 0 0}.sheet .opt:last-of-type{border-radius:0 0 16px 16px}
.sheet .opt:only-of-type{border-radius:16px}
.sheet .opt+.opt:before{left:61px;background:#ffffff12}
.sheet .opt:active{opacity:1;background:#303037}
.sheet .opt small{color:#8e8e96;font-size:12.5px;font-weight:400;margin-top:3px}
.sheet .opt .ico{width:34px;height:34px;flex:0 0 34px;border-radius:10px;font-size:17px;box-shadow:inset 0 1px 0 #ffffff26}
.sheet .opt .ico.gr{background:#3a3a41}
.sheet .cancel{margin-top:10px;padding:15px;border-radius:16px;background:#26262c;color:var(--acc);font-weight:650}
.sheet .cancel:active{background:#303037}
/* boutons ronds en haut */
#notes .ntop span,#ndocs .ntop span{height:36px;padding:0 12px 0 6px;border-radius:99px;background:#ffffff0d;border:1px solid #ffffff10}
#notes .ntop .rb,#ndocs .ntop button,#nmore{width:38px;height:38px;border-radius:50%;display:grid!important;place-items:center;background:#ffffff0d;border:1px solid #ffffff10}
#notes .ntop .rr{display:flex;gap:8px}
#notes .ntop svg.i,#ndocs .ntop svg.i{width:20px;height:20px}
#nedit .eh{padding-top:calc(10px + env(safe-area-inset-top))}
#nedit .eh #nback{height:36px;padding:0 12px 0 6px;border-radius:99px;background:#ffffff0d;border:1px solid #ffffff10}
#nedit .ea{gap:8px}
#nedit .ea button:not(.ok){width:38px;height:38px;border-radius:50%;background:#ffffff0d;border:1px solid #ffffff10}
#nedit .ea svg.i{width:20px!important;height:20px!important}
#nedit .ea .ok{height:36px;padding:0 16px;border-radius:99px;background:var(--acc);color:var(--acc-txt)!important;font-size:15px!important}
/* écran Réglages */
#nset{background:radial-gradient(120% 60% at 50% -10%,#16161c 0%,#000 55%);flex-direction:column}
#nset .st{display:flex;align-items:center;justify-content:space-between;padding:calc(10px + env(safe-area-inset-top)) 12px 4px;color:var(--acc)}
#nset .st button{height:36px;padding:0 12px 0 6px;border-radius:99px;background:#ffffff0d;border:1px solid #ffffff10;display:flex;align-items:center;gap:2px;color:var(--acc);font-size:16px}
#nset h1{text-align:left;font-size:34px;margin:4px 16px 4px;font-weight:700;letter-spacing:-.02em}
#nset .sc{flex:1;overflow-y:auto;padding:4px 16px 60px}
#nset h6{margin:22px 6px 8px;font-size:13px;font-weight:600;color:#8e8e93;text-transform:uppercase;letter-spacing:.06em}
#nset .gp{background:#141416;border:1px solid #ffffff0d;border-radius:16px;overflow:hidden}
#nset .rw{display:flex;align-items:center;gap:13px;width:100%;padding:12px 14px;text-align:left;position:relative;color:#fff;font-size:16px;min-height:54px}
#nset .rw+.rw:before{content:'';position:absolute;top:0;left:61px;right:0;height:1px;background:#ffffff12}
#nset .rw:active{background:#1d1d21}
#nset .rw .ic{width:34px;height:34px;flex:0 0 34px;border-radius:10px;display:grid;place-items:center;font-size:17px;box-shadow:inset 0 1px 0 #ffffff26}
#nset .rw .tx{flex:1;min-width:0}#nset .rw small{display:block;color:#8e8e96;font-size:12.5px;margin-top:2px}
#nset .rw .vl{color:#8e8e96;font-size:15px;display:flex;align-items:center;gap:4px;white-space:nowrap}
#nset .rw .vl svg{width:15px;height:15px;color:#5a5a60}
#nset .rw.dg{color:#ff453a}
.sw2{width:51px;height:31px;flex:none;border-radius:99px;background:#39393f;position:relative;transition:background .25s}
.sw2:after{content:'';position:absolute;top:2px;left:2px;width:27px;height:27px;border-radius:50%;background:#fff;box-shadow:0 2px 6px #0006;transition:transform .25s cubic-bezier(.3,1.4,.5,1)}
.sw2.on{background:var(--acc)}.sw2.on:after{transform:translateX(20px)}
button[hidden],.ea button.hide{display:none!important}
#nset .pal{display:grid;grid-template-columns:repeat(6,1fr);gap:12px 8px;padding:10px 14px 16px;justify-items:center}
#nset .pal button{width:36px;height:36px;flex:none;border-radius:50%;position:relative;box-shadow:inset 0 0 0 2px #0004}
#nset .pal button.on{box-shadow:0 0 0 3px #000,0 0 0 5px currentColor}
#nset .seg{display:flex;background:#0c0c0f;border-radius:11px;padding:3px;margin:0 14px 14px}
#nset .seg button{flex:1;padding:8px 4px;border-radius:9px;color:#a1a1a8;font-size:13.5px;font-weight:600}
#nset .seg button.on{background:#2c2c33;color:#fff;box-shadow:0 1px 4px #0006}
#nset .lbl{padding:12px 14px 8px;color:#fff;font-size:16px;display:flex;justify-content:space-between}
#nset .lbl span{color:#8e8e96;font-size:14px}
#nset .ver{text-align:center;color:#5a5a60;font-size:12.5px;margin:26px 0 0}
.ico.c1{background:linear-gradient(135deg,#ff9f0a,#ff6b00)}.ico.c2{background:linear-gradient(135deg,#0a84ff,#5e5ce6)}.ico.c3{background:linear-gradient(135deg,#30d158,#00a86b)}.ico.c4{background:linear-gradient(135deg,#ff375f,#ff2d92)}.ico.c5{background:linear-gradient(135deg,#bf5af2,#7d3cf0)}.ico.c6{background:linear-gradient(135deg,#64d2ff,#0a84ff)}.ico.c7{background:linear-gradient(135deg,#8e8e93,#5a5a60)}.ico.c8{background:linear-gradient(135deg,#ffd60a,#ff9f0a)}
`;
const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

/* ---------- écran Réglages ---------- */
const chev = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg>';
const sec = document.createElement('section'); sec.id = 'nset'; sec.className = 'scr';
sec.innerHTML = '<div class="st"><button id="sback"><svg class="i"><use href="#i-left"/></svg>Notes</button></div><h1>Réglages</h1><div class="sc" id="sbody"></div>';
document.getElementById('notes').after(sec);
const rw = (id, ic, cls, tx, sub, droite) => `<button class="rw" data-r="${id}"><span class="ic ico ${cls}">${ic}</span><span class="tx">${tx}${sub ? `<small>${sub}</small>` : ''}</span>${droite}</button>`;
const sw = on => `<span class="sw2${on ? ' on' : ''}"></span>`;
const vl = t => `<span class="vl">${t}${chev}</span>`;
function dessiner() {
  const p = P(), sx = window.SEXPget ? window.SEXPget() : {}, scp = (() => { try { return JSON.parse(localStorage.getItem('scanPrefs') || '{}'); } catch (e) { return {}; } })();
  const vue = (() => { try { return localStorage.getItem('nview') || 'list'; } catch (e) { return 'list'; } })(), tri = (() => { try { return localStorage.getItem('nsort') || 'upd'; } catch (e) { return 'upd'; } })();
  const nb = (window.NOTES_N && window.NOTES_N()) || { notes: 0, del: 0, docs: 0 };
  const F = Object.fromEntries((window.SCANCORE && SCANCORE.FILTRES) || [['auto', 'Auto couleur']]);
  document.getElementById('sbody').innerHTML =
    `<h6>Apparence</h6><div class="gp"><div class="lbl">Couleur d’accent<span>${(ACC[p.acc] || ACC.or)[0]}</span></div><div class="pal">${Object.entries(ACC).map(([k, a]) => `<button data-acc="${k}" class="${p.acc === k ? 'on' : ''}" style="background:${a[1]};color:${a[1]}" aria-label="${a[0]}"></button>`).join('')}</div>` +
    `<div class="lbl">Taille du texte<span>${TAILLE[p.taille][0]}</span></div><div class="seg" data-seg="taille">${Object.entries(TAILLE).map(([k, t]) => `<button data-v="${k}" class="${p.taille === k ? 'on' : ''}" style="font-size:${10 + t[1] / 3}px">Aa</button>`).join('')}</div>` +
    `<div class="lbl">Affichage des notes</div><div class="seg" data-seg="vue">${[['list', 'Liste'], ['grid', 'Grille'], ['compact', 'Compacte']].map(([k, t]) => `<button data-v="${k}" class="${vue === k ? 'on' : ''}">${t}</button>`).join('')}</div>` +
    `<div class="lbl">Aperçu du texte</div><div class="seg" data-seg="apercu">${[[0, 'Aucun'], [1, '1 ligne'], [2, '2 lignes'], [3, '3 lignes']].map(([k, t]) => `<button data-v="${k}" class="${+p.apercu === k ? 'on' : ''}">${t}</button>`).join('')}</div>` +
    `<div class="lbl">Trier par</div><div class="seg" data-seg="tri">${[['upd', 'Modification'], ['cre', 'Création'], ['az', 'Titre A→Z']].map(([k, t]) => `<button data-v="${k}" class="${tri === k ? 'on' : ''}">${t}</button>`).join('')}</div></div>` +

    `<h6>Notes</h6><div class="gp">` +
    rw('confirm', '🛡️', 'c2', 'Confirmer avant de supprimer', 'Une question avant d’envoyer une note à la corbeille', sw(p.confirm)) +
    rw('corbeille', '🗑️', 'c7', 'Garder les notes supprimées', 'Ensuite elles sont effacées pour de bon', vl(p.corbeille + ' jours')) +
    rw('dossiers', '📁', 'c8', 'Dossiers', 'Créer, renommer, ranger', vl('')) + `</div>` +

    `<h6>Scanner</h6><div class="gp">` +
    rw('tel', '📱', 'c3', 'Enregistrer sur le téléphone', 'Le PDF va dans Téléchargements', sw(sx.tel)) +
    rw('drive', '☁️', 'c6', 'Enregistrer sur Google Drive', sx.email ? sx.email + ' · « Scans (Notes) »' : 'Dossier « Scans (Notes) »', sw(sx.drive)) +
    rw('ocr', '🔤', 'c5', 'Lire le texte des scans', 'Le texte reconnu est écrit dans la note', sw(p.ocr)) +
    rw('auto', '⚡', 'c1', 'Déclenchement automatique', 'Photo prise dès que le document est stable', sw(scp.a !== false)) +
    rw('filtre', '🎨', 'c4', 'Filtre par défaut', '', vl(F[scp.f || 'auto'] || 'Auto couleur')) +
    rw('qual', '💎', 'c2', 'Qualité des scans', 'Plus haut = plus net, fichier plus lourd', vl({ std: 'Standard', haute: 'Haute', max: 'Maximale' }[scp.q || 'haute'])) +
    rw('nom', '🏷️', 'c8', 'Nom des scans', p.nomAuto !== false ? 'Titre lu dans le document (ex. « Facture 118 – Engie »)' : 'Suivi de la date et de l’heure', vl(p.nomAuto !== false ? 'Automatique' : p.nomScan)) +
    rw('docs', '📄', 'c2', 'Documents scannés', '', vl(nb.docs)) + `</div>` +

    `<h6>Données</h6><div class="gp">` +
    rw('export', '📤', 'c3', 'Exporter toutes les notes', 'Un fichier texte, à garder ou partager', vl('')) +
    rw('import', '📥', 'c6', 'Importer des notes', 'Samsung Notes, texte ou Word', vl('')) +
    (nb.del ? rw('vider', '🧹', 'c7', 'Vider la corbeille', nb.del + ' note' + (nb.del > 1 ? 's' : '') + ' supprimée' + (nb.del > 1 ? 's' : ''), '') : '') + `</div>` +
    `<p class="ver">Notes · ${nb.notes} note${nb.notes > 1 ? 's' : ''} · ${nb.docs} document${nb.docs > 1 ? 's' : ''}</p>`;
}
window.reglagesOuvrir = () => { dessiner(); show('nset'); };
document.getElementById('sback').onclick = () => { notesDraw(); show('notes'); };
document.getElementById('sbody').addEventListener('click', async e => {
  const acc = e.target.closest('[data-acc]');
  if (acc) { Pset({ acc: acc.dataset.acc }); dessiner(); return; }
  const sb = e.target.closest('.seg button');
  if (sb) {
    const k = sb.parentElement.dataset.seg, v = sb.dataset.v;
    if (k === 'taille') Pset({ taille: v });
    if (k === 'apercu') Pset({ apercu: +v });
    if (k === 'vue') try { localStorage.setItem('nview', v); window.nVue && window.nVue(v); } catch (er) {}
    if (k === 'tri') try { localStorage.setItem('nsort', v); window.nTri && window.nTri(v); } catch (er) {}
    dessiner(); return;
  }
  const r = e.target.closest('.rw'); if (!r) return;
  const id = r.dataset.r, p = P();
  const scp = (() => { try { return JSON.parse(localStorage.getItem('scanPrefs') || '{}'); } catch (er) { return {}; } })();
  const scpSet = o => { try { localStorage.setItem('scanPrefs', JSON.stringify(Object.assign(scp, o))); } catch (er) {} window.scanPrefsRelire && window.scanPrefsRelire(); };
  if (id === 'confirm') Pset({ confirm: !p.confirm });
  if (id === 'ocr') Pset({ ocr: !p.ocr });
  if (id === 'auto') scpSet({ a: scp.a === false });
  if (id === 'corbeille') { const v = await sheet('Garder les notes supprimées', [7, 30, 90].map(j => ({ v: j, ico: '🗓️', label: j + ' jours' + (p.corbeille === j ? '  ✓' : '') }))); if (v) Pset({ corbeille: v }); }
  if (id === 'filtre') { const v = await sheet('Filtre par défaut', [['auto', '✨', 'Auto couleur', 'Couleurs nettes, fond blanc'], ['doc', '📄', 'Document', 'Papier très blanc, texte bien noir'], ['vif', '🌈', 'Couleurs vives', 'Pour les dépliants, dessins, tampons'], ['photo', '📷', 'Photo', 'Garde l’ambiance, corrige la lumière'], ['tableau', '🧑‍🏫', 'Tableau blanc', 'Efface les reflets, feutres éclatants'], ['bw', '⚫', 'Noir & blanc', 'Idéal pour le texte'], ['encre', '✒️', 'Texte net', 'Noir pur sur blanc pur, comme un fax'], ['gray', '🩶', 'Gris', 'Doux et lisible'], ['eco', '🍃', 'Éco encre', 'Imprime en consommant moins'], ['sepia', '🟤', 'Ancien', 'Ton sépia chaleureux'], ['orig', '🖼️', 'Original', 'Sans retouche']].map(([v, i, l, s]) => ({ v, ico: i, label: l + ((scp.f || 'auto') === v ? '  ✓' : ''), sub: s }))); if (v) scpSet({ f: v }); }
  if (id === 'qual') { const q = scp.q || 'haute'; const v = await sheet('Qualité des scans', [['std', '⚡', 'Standard', 'Rapide, fichiers légers'], ['haute', '💎', 'Haute', 'Photo pleine résolution, texte net (conseillé)'], ['max', '🔬', 'Maximale', 'Le plus net possible, PDF plus lourds']].map(([v, i, l, s]) => ({ v, ico: i, label: l + (q === v ? '  ✓' : ''), sub: s }))); if (v) scpSet({ q: v }); }
  if (id === 'nom') { const w = await sheet('Nom des scans', [{ v: 'auto', ico: '✨', label: 'Automatique' + (p.nomAuto !== false ? '  ✓' : ''), sub: 'Le genre et le titre lus dans le document : « Facture 2026-118 – Haythem Food – 25-11-2026 »' }, { v: 'fixe', ico: '🏷️', label: 'Nom fixe + date' + (p.nomAuto === false ? '  ✓' : ''), sub: '« ' + p.nomScan + ' 2026-11-25 10h15 »' }]);
    if (w === 'auto') Pset({ nomAuto: true });
    if (w === 'fixe') { let v = await ask({ title: 'Nom des scans', text: 'Ex. « Facture » donnera « Facture 2026-11-25 10h15 ».', input: p.nomScan, ok: 'Enregistrer' }); v = (v || '').trim().replace(/[\\/:*?"<>|]/g, '').slice(0, 30); if (v) Pset({ nomScan: v, nomAuto: false }); } }
  if (id === 'tel' && window.SEXPset) { const s = window.SEXPget(); window.SEXPset({ tel: !s.tel }); }
  if (id === 'drive' && window.SEXPset) { const s = window.SEXPget(); if (s.drive) window.SEXPset({ drive: false }); else { window.SEXPset({ drive: true }); try { await window.nAuthPub(); toast('Google Drive relié ✓'); } catch (er) { toast('Connexion Google annulée'); } } }
  if (id === 'docs') return docsOpen();
  if (id === 'dossiers') { window.dossiersOuvrir && window.dossiersOuvrir(); return; }
  if (id === 'import') { pickerOpen = true; setTimeout(() => pickerOpen = false, 90000); document.getElementById('nin').click(); }
  if (id === 'export') window.notesExporter && window.notesExporter();
  if (id === 'vider') window.corbeilleVider && await window.corbeilleVider();
  dessiner();
});

/* bouton Réglages à côté du menu ⋯ */
const more = document.getElementById('nmore');
const g = document.createElement('button'); g.id = 'nreg'; g.className = 'rb'; g.setAttribute('aria-label', 'Réglages'); g.style.color = 'inherit';
g.innerHTML = '<svg class="i"><use href="#i-gear"/></svg>';
const box = document.createElement('div'); box.className = 'rr'; more.before(box); box.append(g, more);
g.onclick = () => window.reglagesOuvrir();

appliquer();
convertir(); setTimeout(convertir, 0); setTimeout(convertir, 1500);
new MutationObserver(() => convertir()).observe(document.head, { childList: true });
})();
