// Claire : serveur de l'assistante vocale d'Ahmed.
// - /claire-google/start?l=<clé de liaison>  : ouvre la page d'autorisation Google
// - /claire-google/callback                   : Google revient ici, on garde le jeton de rafraîchissement
// - /claire-google/tool/<action>              : appelé par Claire (ElevenLabs), protégé par une clé
// - /claire-google/reglages                  : API des réglages (page sur vander185.github.io/claire/reglages.html)
// - /claire-google/cron/briefing              : appelé chaque quart d'heure par pg_cron (briefing du matin)
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const BASE = Deno.env.get("SUPABASE_URL")! + "/functions/v1/claire-google";
const SCOPES = "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.events";
const TZ = "Europe/Brussels";

async function cfg(k: string) { const { data } = await db.from("claire_cfg").select("v").eq("k", k).maybeSingle(); return data?.v ?? null; }
async function setCfg(k: string, v: string) { await db.from("claire_cfg").upsert({ k, v, updated_at: new Date().toISOString() }); }
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8" } });
const page = (t: string, s = 200) => new Response(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><body style="font:18px system-ui;background:#0b0b12;color:#f4f2f7;display:grid;place-items:center;min-height:90vh;text-align:center;padding:20px"><div>${t}</div>`, { status: s, headers: { "content-type": "text/html; charset=utf-8" } });
function same(a: string, b: string) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }

/* ---------- Heure de Bruxelles ---------- */
function tzOff(d: Date) { // minutes d'avance de Bruxelles sur UTC à cet instant
  const p = (z: string) => Date.parse(d.toLocaleString("en-US", { timeZone: z }));
  return Math.round((p(TZ) - p("UTC")) / 60000);
}
function local(d: Date) { // composantes de la date à Bruxelles
  const o = new Date(d.getTime() + tzOff(d) * 60000);
  return { y: o.getUTCFullYear(), m: o.getUTCMonth() + 1, d: o.getUTCDate(), h: o.getUTCHours(), mi: o.getUTCMinutes(), wd: o.getUTCDay() };
}
function zoned(y: number, m: number, d: number, h = 0, mi = 0) { // heure de Bruxelles → Date
  const g = Date.UTC(y, m - 1, d, h, mi); let t = g - tzOff(new Date(g)) * 60000; t = g - tzOff(new Date(t)) * 60000; return new Date(t);
}
const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const hm = (h: number, mi: number) => `${h}h${String(mi).padStart(2, "0")}`;
function dit(d: Date) { const l = local(d); return `${JOURS[l.wd]} ${l.d} ${MOIS[l.m - 1]} à ${hm(l.h, l.mi)}`; }
function hdit(d: Date) { const l = local(d); return hm(l.h, l.mi); }

/* ---------- Numéros belges ---------- */
function normTel(s: unknown) {
  let t = String(s ?? "").replace(/[^\d+]/g, "");
  if (!t) return "";
  if (t.startsWith("00")) t = "+" + t.slice(2);
  else if (t.startsWith("0")) t = "+32" + t.slice(1);
  else if (!t.startsWith("+") && t.length >= 10) t = "+" + t;
  return t;
}
const telDit = (t: string) => t.replace(/^\+32/, "0").replace(/^(\d{4})(\d{2})(\d{2})(\d{2})$/, "$1 $2 $3 $4");

/* ---------- Google ---------- */
let cached: { t: string; exp: number } | null = null;
async function accessToken(): Promise<string> {
  if (cached && cached.exp > Date.now() + 60000) return cached.t;
  const rt = await cfg("refresh_token"); if (!rt) throw new Error("not_linked");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({ client_id: (await cfg("client_id"))!, client_secret: (await cfg("client_secret"))!, refresh_token: rt, grant_type: "refresh_token" }) });
  const j = await r.json(); if (!j.access_token) throw new Error("refresh_failed");
  cached = { t: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return cached.t;
}
async function g(url: string, init: RequestInit = {}) {
  const t = await accessToken();
  const r = await fetch(url, { ...init, headers: { ...(init.headers || {}), authorization: "Bearer " + t, "content-type": "application/json" } });
  if (!r.ok) throw new Error("google_" + r.status + ": " + (await r.text()).slice(0, 200));
  return r.json();
}
const hdr = (m: any, n: string) => (m.payload?.headers || []).find((h: any) => h.name.toLowerCase() === n)?.value || "";
function bodyText(p: any): string {
  if (!p) return "";
  if (p.mimeType === "text/plain" && p.body?.data) return atob(p.body.data.replace(/-/g, "+").replace(/_/g, "/"));
  for (const x of p.parts || []) { const t = bodyText(x); if (t) return t; }
  if (p.mimeType === "text/html" && p.body?.data) return atob(p.body.data.replace(/-/g, "+").replace(/_/g, "/")).replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ");
  return "";
}
const utf8 = (s: string) => { try { return decodeURIComponent(escape(s)); } catch { return s; } };
async function events(from: Date, to: Date) {
  const l = await g("https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=100&timeZone=" + TZ + "&timeMin=" + from.toISOString() + "&timeMax=" + to.toISOString());
  return (l.items || []).filter((e: any) => e.status !== "cancelled");
}
async function unread(n = 5) {
  const l = await g("https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=" + n + "&q=" + encodeURIComponent("in:inbox is:unread -category:promotions -category:social"));
  const out = [];
  for (const m of l.messages || []) {
    const d = await g(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`);
    out.push({ de: hdr(d, "from").replace(/<[^>]+>/, "").replace(/"/g, "").trim(), sujet: hdr(d, "subject") });
  }
  return { total: l.resultSizeEstimate ?? out.length, emails: out };
}

/* ---------- Horaires pour les rendez-vous (modifiables dans les réglages) ---------- */
const HORAIRES_DEF: Record<string, [number, number]> = { "1": [9, 18], "2": [9, 18], "3": [9, 18], "4": [9, 18], "5": [9, 18], "6": [10, 14] };
async function horaires(): Promise<Record<string, [number, number]>> { try { return JSON.parse((await cfg("horaires")) || "") || HORAIRES_DEF; } catch { return HORAIRES_DEF; } }

async function creneaux(a: any) {
  const dur = Math.max(15, Math.min(240, Number(a.duree_minutes) || 30));
  const H = await horaires(), now = new Date();
  let start = a.jour ? new Date(a.jour) : now; if (isNaN(+start)) start = now;
  const s0 = local(start);
  const nbJ = Math.max(1, Math.min(14, Number(a.nombre_jours) || (a.jour ? 1 : 5)));
  const from = zoned(s0.y, s0.m, s0.d), to = new Date(from.getTime() + (nbJ + 1) * 864e5);
  const busy = (await events(from, to)).filter((e: any) => e.start?.dateTime && e.transparency !== "transparent").map((e: any) => [Date.parse(e.start.dateTime), Date.parse(e.end.dateTime)]);
  const out: { debut: string; dit: string }[] = []; const max = Math.max(1, Math.min(8, Number(a.nombre) || 4));
  for (let k = 0; k < nbJ + 3 && out.length < max; k++) {
    const day = local(new Date(from.getTime() + k * 864e5 + 3 * 36e5)); const h = H[String(day.wd)]; if (!h) continue;
    let n = 0;
    for (let t = zoned(day.y, day.m, day.d, h[0]).getTime(); t + dur * 60000 <= zoned(day.y, day.m, day.d, h[1]).getTime() && n < 3 && out.length < max; t += 30 * 60000) {
      if (t < now.getTime() + 60 * 60000) continue;   // au moins une heure à l'avance
      const e = t + dur * 60000;
      if (busy.some(([b0, b1]) => t < b1 + 10 * 60000 && e > b0 - 10 * 60000)) continue;   // 10 min de battement
      out.push({ debut: new Date(t).toISOString(), dit: dit(new Date(t)) }); n++; t += 60 * 60000;   // créneaux espacés
    }
  }
  return { duree_minutes: dur, creneaux: out, note: out.length ? "Propose deux ou trois de ces créneaux, puis crée le rendez-vous avec creer_rendez_vous." : "Aucun créneau libre sur la période : propose de noter les disponibilités de la personne." };
}

/* ---------- WhatsApp vers Ahmed (CallMeBot, usage personnel gratuit) ---------- */
async function whatsapp(text: string) {
  const ph = await cfg("wa_phone"), key = await cfg("wa_key");
  if (!ph || !key) return { ok: false, erreur: "WhatsApp n'est pas encore configuré dans les réglages de Claire." };
  try {
    const r = await fetch("https://api.callmebot.com/whatsapp.php?phone=" + encodeURIComponent(ph) + "&apikey=" + encodeURIComponent(key) + "&text=" + encodeURIComponent(text.slice(0, 3500)));
    const b = await r.text();
    return r.ok && !/error|invalid|not/i.test(b.slice(0, 300)) ? { ok: true } : { ok: false, erreur: "WhatsApp a refusé : " + b.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 160) };
  } catch (e) { return { ok: false, erreur: "WhatsApp injoignable : " + String((e as Error).message).slice(0, 100) }; }
}

/* ---------- Contacts, mémoire, appels ---------- */
async function contactParTel(tel: string) {
  if (!tel) return null;
  const { data } = await db.from("claire_contacts").select("*").eq("tel", tel).maybeSingle(); return data;
}
const mots = (s: string) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9+]+/).filter((w) => w.length > 2);

async function briefingData() {
  const now = new Date(), l = local(now), from = zoned(l.y, l.m, l.d), to = new Date(from.getTime() + 864e5);
  const out: any = { date: `${JOURS[l.wd]} ${l.d} ${MOIS[l.m - 1]}` };
  try { out.agenda = (await events(from, to)).map((e: any) => ({ titre: e.summary || "(sans titre)", heure: e.start?.dateTime ? hdit(new Date(e.start.dateTime)) : "toute la journée", lieu: e.location || "" })); } catch (e) { out.agenda_erreur = String((e as Error).message).startsWith("not_linked") ? "agenda non relié" : "agenda indisponible"; }
  try { out.emails_non_lus = await unread(5); } catch { out.emails_erreur = "e-mails indisponibles"; }
  const { data: ap } = await db.from("claire_appels").select("created_at,nom,tel,motif,action,urgence").eq("lu", false).order("created_at", { ascending: false }).limit(10);
  out.appels_non_lus = (ap || []).map((a) => ({ quand: dit(new Date(a.created_at)), nom: a.nom, tel: a.tel, motif: a.motif, a_faire: a.action, urgence: a.urgence }));
  try {
    const w = await (await fetch("https://api.open-meteo.com/v1/forecast?latitude=50.85&longitude=4.35&current=temperature_2m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=Europe%2FBrussels&forecast_days=1")).json();
    const code = w.daily.weather_code[0], ciel = code <= 1 ? "ensoleillé" : code <= 3 ? "nuageux" : code <= 48 ? "brouillard" : code <= 67 ? "pluie" : code <= 77 ? "neige" : code <= 82 ? "averses" : "orages";
    out.meteo = { maintenant: Math.round(w.current.temperature_2m), min: Math.round(w.daily.temperature_2m_min[0]), max: Math.round(w.daily.temperature_2m_max[0]), pluie_pourcent: w.daily.precipitation_probability_max[0], ciel };
  } catch { /* */ }
  return out;
}
function briefingTexte(b: any) {
  const L = [`☀️ *Bonjour Ahmed !* Ton briefing du ${b.date}`];
  if (b.meteo) L.push(`\n🌤 *Météo Bruxelles* : ${b.meteo.ciel}, ${b.meteo.min}° à ${b.meteo.max}°${b.meteo.pluie_pourcent >= 30 ? `, pluie ${b.meteo.pluie_pourcent} % ☔` : ""}`);
  L.push(`\n📅 *Agenda*` + (b.agenda_erreur ? ` : ${b.agenda_erreur}` : b.agenda?.length ? "\n" + b.agenda.map((e: any) => `• ${e.heure} — ${e.titre}${e.lieu ? " (" + e.lieu + ")" : ""}`).join("\n") : " : rien de prévu aujourd'hui"));
  if (b.appels_non_lus?.length) L.push(`\n📞 *Appels à traiter (${b.appels_non_lus.length})*\n` + b.appels_non_lus.map((a: any) => `• ${a.nom || "Inconnu"}${a.tel ? " " + telDit(a.tel) : ""} — ${a.motif || ""}${a.urgence === "haute" ? " ⚠️" : ""}`).join("\n"));
  if (b.emails_non_lus) L.push(`\n✉️ *E-mails non lus : ${b.emails_non_lus.total}*` + (b.emails_non_lus.emails.length ? "\n" + b.emails_non_lus.emails.slice(0, 4).map((e: any) => `• ${e.de} — ${e.sujet}`).join("\n") : ""));
  L.push(`\nBonne journée ! — Claire`);
  return L.join("\n");
}

async function tool(action: string, a: any) {
  if (action === "gmail_recent") {
    const q = a.recherche ? String(a.recherche) : (a.non_lus === false ? "in:inbox" : "in:inbox is:unread");
    const l = await g("https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=" + Math.min(10, a.nombre || 6) + "&q=" + encodeURIComponent(q + " -category:promotions -category:social"));
    const out = [];
    for (const m of l.messages || []) {
      const d = await g(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
      out.push({ id: m.id, de: hdr(d, "from").replace(/<[^>]+>/, "").trim(), sujet: hdr(d, "subject"), date: hdr(d, "date"), apercu: d.snippet });
    }
    return { recherche: q, nombre: out.length, emails: out };
  }
  if (action === "gmail_read") {
    const d = await g(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(a.id)}?format=full`);
    return { de: hdr(d, "from"), sujet: hdr(d, "subject"), date: hdr(d, "date"), texte: utf8(bodyText(d.payload)).replace(/\s+\n/g, "\n").replace(/[ \t]{2,}/g, " ").slice(0, 4000) };
  }
  if (action === "agenda_list") {
    const from = a.debut ? new Date(a.debut) : new Date(); const to = a.fin ? new Date(a.fin) : new Date(from.getTime() + 7 * 864e5);
    return { du: from.toISOString(), au: to.toISOString(), rendez_vous: (await events(from, to)).slice(0, 25).map((e: any) => ({ titre: e.summary, debut: e.start?.dateTime || e.start?.date, fin: e.end?.dateTime || e.end?.date, lieu: e.location || "" })) };
  }
  if (action === "agenda_add") {
    const s = new Date(a.debut); if (isNaN(+s)) return { erreur: "date de début illisible" };
    const e = new Date(s.getTime() + (a.duree_minutes || 60) * 60000);
    // pas de double réservation
    const clash = (await events(s, e)).filter((x: any) => x.start?.dateTime && x.transparency !== "transparent");
    if (clash.length && !a.forcer) return { erreur: `Ce créneau est déjà pris (${clash[0].summary || "rendez-vous"}). Propose un autre créneau avec creneaux_libres.` };
    const desc = [a.note, a.tel ? "Tél. : " + telDit(normTel(a.tel)) : "", "Ajouté par Claire"].filter(Boolean).join("\n");
    const ev = await g("https://www.googleapis.com/calendar/v3/calendars/primary/events", { method: "POST", body: JSON.stringify({ summary: a.titre, location: a.lieu || undefined, description: desc, start: { dateTime: s.toISOString(), timeZone: TZ }, end: { dateTime: e.toISOString(), timeZone: TZ }, reminders: { useDefault: true } }) });
    if (a.par_telephone) await whatsapp(`📅 *Nouveau rendez-vous pris par Claire*\n${a.titre}\n${dit(s)} (${a.duree_minutes || 60} min)${a.tel ? "\nTél. : " + telDit(normTel(a.tel)) : ""}${a.note ? "\n" + a.note : ""}`);
    return { ok: true, titre: ev.summary, debut: ev.start?.dateTime, dit: dit(s) };
  }
  if (action === "creneaux_libres") return await creneaux(a);

  /* mémoire partagée (appli + téléphone) */
  if (action === "memoire_ajouter") {
    const t = String(a.texte || "").trim(); if (!t) return { erreur: "rien à retenir" };
    await db.from("claire_memoire").insert({ texte: t.slice(0, 1000), sujet: a.sujet ? String(a.sujet).slice(0, 80) : null });
    return { ok: true, retenu: t };
  }
  if (action === "memoire_chercher") {
    const { data } = await db.from("claire_memoire").select("id,texte,sujet,created_at").order("created_at", { ascending: false }).limit(300);
    const w = mots(a.recherche || "");
    const sc = (data || []).map((m) => ({ m, s: w.length ? w.filter((x) => mots(m.texte + " " + (m.sujet || "")).some((y) => y.startsWith(x) || x.startsWith(y))).length : 1 })).filter((x) => x.s > 0).sort((p, q) => q.s - p.s);
    return { trouve: sc.length, souvenirs: sc.slice(0, 12).map(({ m }) => ({ id: m.id, sujet: m.sujet, texte: m.texte, le: dit(new Date(m.created_at)) })) };
  }
  if (action === "memoire_oublier") {
    const { data } = await db.from("claire_memoire").delete().eq("id", Number(a.id)).select("texte");
    return data?.length ? { ok: true, oublie: data[0].texte } : { erreur: "souvenir introuvable" };
  }

  /* contacts */
  if (action === "contact_ajouter") {
    const nom = String(a.nom || "").trim(), tel = normTel(a.tel); if (!nom) return { erreur: "il faut au moins un nom" };
    const ex = tel ? await contactParTel(tel) : (await db.from("claire_contacts").select("*").ilike("nom", nom).maybeSingle()).data;
    const row: any = { nom, updated_at: new Date().toISOString() }; if (tel) row.tel = tel; if (typeof a.vip === "boolean") row.vip = a.vip; if (a.note) row.note = String(a.note).slice(0, 500);
    if (ex) await db.from("claire_contacts").update(row).eq("id", ex.id); else await db.from("claire_contacts").insert(row);
    return { ok: true, nom, tel: tel ? telDit(tel) : "", vip: row.vip ?? ex?.vip ?? false };
  }
  if (action === "contact_chercher") {
    const w = mots(a.recherche || ""); const t = normTel(a.recherche);
    const { data } = await db.from("claire_contacts").select("nom,tel,vip,note").order("nom").limit(500);
    const r = (data || []).filter((c) => !w.length || (t.length > 6 && c.tel === t) || w.some((x) => mots(c.nom + " " + (c.note || "")).some((y) => y.startsWith(x))));
    return { trouve: r.length, contacts: r.slice(0, 15).map((c) => ({ ...c, tel: c.tel ? telDit(c.tel) : "", tel_international: c.tel })) };
  }
  if (action === "appelant_info") {   // au début d'un appel reçu
    const tel = normTel(a.tel); const c = await contactParTel(tel);
    const { count } = await db.from("claire_appels").select("id", { count: "exact", head: true }).eq("tel", tel || "-");
    const { data: last } = await db.from("claire_appels").select("created_at,motif").eq("tel", tel || "-").order("created_at", { ascending: false }).limit(1);
    return { numero: tel ? telDit(tel) : "masqué", connu: !!c, nom: c?.nom || null, vip: !!c?.vip, note: c?.note || null, appels_precedents: count || 0, dernier_appel: last?.[0] ? `${dit(new Date(last[0].created_at))} : ${last[0].motif || ""}` : null };
  }

  /* appels reçus : noter + prévenir Ahmed sur WhatsApp */
  if (action === "appel_noter") {
    const tel = normTel(a.tel); const urg = ["haute", "normale", "basse"].includes(a.urgence) ? a.urgence : "normale";
    const row = { nom: a.nom || null, tel: tel || null, motif: a.motif || null, action: a.action || null, urgence: urg, message: a.message || null, rdv: a.rendez_vous || null };
    const { data } = await db.from("claire_appels").insert(row).select("id").single();
    if (tel && a.nom && !(await contactParTel(tel))) await db.from("claire_contacts").insert({ nom: a.nom, tel, note: "Ajouté par Claire après un appel" });
    const t = `${urg === "haute" ? "🚨 *Appel URGENT*" : "📞 *Appel reçu par Claire*"}\n👤 ${a.nom || "Inconnu"}${tel ? " — " + telDit(tel) : ""}\n💬 ${a.motif || "—"}${a.message ? "\n📝 " + a.message : ""}${a.rendez_vous ? "\n📅 " + a.rendez_vous : ""}\n✅ À faire : ${a.action || "rien"}${tel ? "\n\nRappeler : https://wa.me/" + tel.replace("+", "") : ""}`;
    const w = await whatsapp(t); await db.from("claire_appels").update({ wa_ok: w.ok }).eq("id", data!.id);
    return { ok: true, transmis_whatsapp: w.ok };
  }
  if (action === "appels_lire") {
    let q = db.from("claire_appels").select("id,created_at,nom,tel,motif,action,urgence,message,rdv,lu").order("created_at", { ascending: false }).limit(Math.min(15, Number(a.nombre) || 8));
    if (a.tous !== true) q = q.eq("lu", false);
    const { data } = await q;
    if (data?.length && a.marquer_lus !== false) await db.from("claire_appels").update({ lu: true }).in("id", data.map((x) => x.id));
    return { nombre: data?.length || 0, appels: (data || []).map((x) => ({ quand: dit(new Date(x.created_at)), nom: x.nom, tel: x.tel ? telDit(x.tel) : "", tel_international: x.tel, motif: x.motif, message: x.message, rendez_vous: x.rdv, a_faire: x.action, urgence: x.urgence })) };
  }
  if (action === "briefing") return await briefingData();
  if (action === "whatsapp_moi") {
    const t = String(a.texte || "").trim(); if (!t) return { erreur: "message vide" };
    return await whatsapp("🤖 *Claire* :\n" + t);
  }
  return { erreur: "action inconnue" };
}

/* ---------- Réglages : API JSON pour la page vander185.github.io/claire/reglages.html ---------- */
const CORS = { "access-control-allow-origin": "https://vander185.github.io", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", "vary": "origin" };
async function reglages(req: Request) {
  const link = await cfg("link_key"); const f = await req.json().catch(() => ({})) as any;
  const out = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  if (!link || !same(String(f.l || ""), link)) return out({ erreur: "Lien invalide." }, 403);
  let msg = "";
  const op = f.op;
  if (op === "wa") {
    await setCfg("wa_phone", normTel(f.wa_phone)); if (typeof f.wa_key === "string" && f.wa_key.trim() !== "••••") await setCfg("wa_key", f.wa_key.trim());
    await setCfg("briefing_on", f.briefing_on ? "1" : "0"); await setCfg("briefing_heure", /^\d{1,2}:\d{2}$/.test(f.briefing_heure || "") ? f.briefing_heure : "07:45");
    msg = "✅ Réglages enregistrés.";
    if (f.test) { const w = await whatsapp("✅ Claire est bien reliée à ton WhatsApp. Tu recevras ici les appels pris par Claire et ton briefing du matin."); msg = w.ok ? "✅ Enregistré. Message de test envoyé sur WhatsApp." : "⚠️ Enregistré, mais le test a échoué : " + w.erreur; }
  }
  if (op === "brief_now") { const w = await whatsapp(briefingTexte(await briefingData())); msg = w.ok ? "✅ Briefing envoyé sur WhatsApp." : "⚠️ " + w.erreur; }
  if (op === "h") {
    const H: Record<string, [number, number]> = {};
    for (const [d, v] of Object.entries(f.horaires || {})) { const [x, y] = (v as number[]).map(Number); if (/^[0-6]$/.test(d) && y > x && x >= 0 && y <= 24) H[d] = [x, y]; }
    await setCfg("horaires", JSON.stringify(H)); msg = "✅ Horaires enregistrés.";
  }
  if (op === "add") { const r = await tool("contact_ajouter", { nom: f.nom, tel: f.tel, vip: !!f.vip, note: f.note || undefined }) as any; msg = r.ok ? "✅ Contact enregistré." : "⚠️ " + r.erreur; }
  if (op === "vip") { await db.from("claire_contacts").update({ vip: !!f.v }).eq("id", f.id); msg = "✅ Contact modifié."; }
  if (op === "del") { await db.from("claire_contacts").delete().eq("id", f.id); msg = "✅ Contact supprimé."; }
  if (op === "mem_del") { await db.from("claire_memoire").delete().eq("id", Number(f.id)); msg = "✅ Souvenir effacé."; }
  const { data: cs } = await db.from("claire_contacts").select("id,nom,tel,vip,note").order("vip", { ascending: false }).order("nom").limit(300);
  const { data: ap } = await db.from("claire_appels").select("created_at,nom,tel,motif,action,urgence,message,wa_ok").order("created_at", { ascending: false }).limit(15);
  const { data: me } = await db.from("claire_memoire").select("id,texte,sujet,created_at").order("created_at", { ascending: false }).limit(50);
  const ph = await cfg("wa_phone");
  return out({
    msg, wa_phone: ph ? telDit(ph) : "", wa_key: (await cfg("wa_key")) ? "••••" : "", briefing_on: (await cfg("briefing_on")) !== "0", briefing_heure: (await cfg("briefing_heure")) || "07:45",
    horaires: await horaires(), google: (await cfg("email")) || "",
    contacts: (cs || []).map((c) => ({ ...c, tel: c.tel ? telDit(c.tel) : "" })),
    appels: (ap || []).map((a) => ({ ...a, quand: dit(new Date(a.created_at)), tel: a.tel ? telDit(a.tel) : "" })),
    memoire: (me || []).map((m) => ({ id: m.id, texte: m.texte, sujet: m.sujet, le: dit(new Date(m.created_at)) })),
  });
}

Deno.serve(async (req) => {
  const u = new URL(req.url); const path = u.pathname.replace(/^.*\/claire-google/, "");
  try {
    if (path === "/start") {
      const link = await cfg("link_key"); const cid = await cfg("client_id");
      if (!link || !cid || !same(u.searchParams.get("l") || "", link)) return page("Lien invalide.", 403);
      const state = crypto.randomUUID(); await setCfg("oauth_state", state + "|" + Date.now());
      const p = new URLSearchParams({ client_id: cid, redirect_uri: BASE + "/callback", response_type: "code", scope: SCOPES, access_type: "offline", prompt: "consent", state, include_granted_scopes: "true" });
      return Response.redirect("https://accounts.google.com/o/oauth2/v2/auth?" + p, 302);
    }
    if (path === "/callback") {
      const [st, t] = ((await cfg("oauth_state")) || "|0").split("|");
      if (!u.searchParams.get("state") || !same(u.searchParams.get("state")!, st) || Date.now() - +t > 15 * 60000) return page("Lien expiré : recommencez depuis l'appli Claire.", 400);
      if (u.searchParams.get("error")) return page("Autorisation annulée.", 400);
      const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({ code: u.searchParams.get("code")!, client_id: (await cfg("client_id"))!, client_secret: (await cfg("client_secret"))!, redirect_uri: BASE + "/callback", grant_type: "authorization_code" }) });
      const j = await r.json(); if (!j.refresh_token) return page("Google n'a pas donné l'accès. Réessayez.", 400);
      await setCfg("refresh_token", j.refresh_token); await setCfg("oauth_state", "x|0"); cached = null;
      let mail = ""; try { mail = JSON.parse(atob(j.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).email; await setCfg("email", mail); } catch { /* */ }
      return page(`✅ C'est fait !<br><br>Claire peut maintenant lire vos e-mails et votre agenda${mail ? " (" + mail + ")" : ""}.<br><br>Vous pouvez fermer cette page.`);
    }
    if (path === "/reglages") { if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS }); if (req.method === "POST") return await reglages(req); }
    if (path === "/cron/briefing" && req.method === "POST") {
      const key = await cfg("tool_key");
      if (!key || !same(req.headers.get("x-claire-key") || "", key)) return json({ erreur: "non autorisé" }, 401);
      if ((await cfg("briefing_on")) === "0" || !(await cfg("wa_key"))) return json({ ok: true, envoye: false, raison: "désactivé ou WhatsApp non configuré" });
      const l = local(new Date()), today = `${l.y}-${l.m}-${l.d}`, [bh, bm] = ((await cfg("briefing_heure")) || "07:45").split(":").map(Number);
      const mins = l.h * 60 + l.mi - (bh * 60 + bm);
      if (mins < 0 || mins > 40 || (await cfg("briefing_last")) === today) return json({ ok: true, envoye: false });
      await setCfg("briefing_last", today);
      return json({ ok: true, envoye: true, ...(await whatsapp(briefingTexte(await briefingData()))) });
    }
    if (path.startsWith("/tool/") && req.method === "POST") {
      const key = await cfg("tool_key");
      if (!key || !same(req.headers.get("x-claire-key") || "", key)) return json({ erreur: "non autorisé" }, 401);
      const a = await req.json().catch(() => ({}));
      try { return json(await tool(path.slice(6), a)); }
      catch (e) { const m = String((e as Error).message); return json({ erreur: m === "not_linked" ? "Gmail et l'agenda ne sont pas encore reliés : Ahmed doit autoriser Claire une fois." : "Google ne répond pas : " + m.slice(0, 120) }); }
    }
    return json({ ok: true });
  } catch (e) { return json({ erreur: String((e as Error).message).slice(0, 200) }, 500); }
});
