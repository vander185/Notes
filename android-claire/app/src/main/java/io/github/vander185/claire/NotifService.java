package io.github.vander185.claire;

import android.app.Notification;
import android.content.ComponentName;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.provider.Settings;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.HashMap;
import android.app.RemoteInput;
import android.content.Intent;
import android.media.AudioManager;
import java.util.Iterator;

/**
 * Lecture des notifications reçues (WhatsApp, SMS…) pour que Claire puisse les résumer.
 * Rien n'est envoyé ailleurs : la liste reste dans la mémoire du téléphone (60 dernières, 24 h).
 */
public class NotifService extends NotificationListenerService {
    private static final ArrayDeque<JSONObject> recues = new ArrayDeque<>();
    /** bouton « Répondre » de chaque notification de message (WhatsApp, SMS, Messenger, Telegram…) */
    private static final HashMap<String, Notification.Action> reponses = new HashMap<>();
    private static long derniereAnnonce = 0;
    private static String dernierTexteAnnonce = "";
    static final java.util.Set<String> MESSAGERIES = new java.util.HashSet<>(java.util.Arrays.asList(
        "com.whatsapp", "com.whatsapp.w4b", "com.google.android.apps.messaging", "com.samsung.android.messaging",
        "org.telegram.messenger", "com.facebook.orca", "com.instagram.android", "com.snapchat.android", "com.viber.voip", "com.android.mms"));
    static NotifService instance;

    @Override public void onListenerConnected() { instance = this; }
    @Override public void onListenerDisconnected() { instance = null; }

    static boolean autorise(Context c) {
        String s = Settings.Secure.getString(c.getContentResolver(), "enabled_notification_listeners");
        return s != null && s.contains(new ComponentName(c, NotifService.class).flattenToString());
    }

    private static JSONObject lire(Context c, StatusBarNotification sbn) {
        try {
            Notification n = sbn.getNotification();
            if ((n.flags & Notification.FLAG_ONGOING_EVENT) != 0 || (n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return null;
            if (c.getPackageName().equals(sbn.getPackageName())) return null;
            Bundle e = n.extras;
            CharSequence titre = e.getCharSequence(Notification.EXTRA_TITLE);
            CharSequence texte = e.getCharSequence(Notification.EXTRA_BIG_TEXT);
            if (texte == null) texte = e.getCharSequence(Notification.EXTRA_TEXT);
            if (titre == null && texte == null) return null;
            String app = sbn.getPackageName();
            try { PackageManager pm = c.getPackageManager(); app = pm.getApplicationLabel(pm.getApplicationInfo(sbn.getPackageName(), 0)).toString(); } catch (Exception ignored) { }
            JSONObject o = new JSONObject();
            o.put("app", app); o.put("pkg", sbn.getPackageName());
            o.put("titre", titre == null ? "" : titre.toString());
            String t = texte == null ? "" : texte.toString();
            o.put("texte", t.length() > 500 ? t.substring(0, 500) + "…" : t);
            o.put("t", sbn.getPostTime());
            o.put("cle", sbn.getKey());
            // dernier message de la conversation (WhatsApp regroupe plusieurs messages dans une notification)
            android.os.Parcelable[] msgs = e.getParcelableArray(Notification.EXTRA_MESSAGES);
            if (msgs != null && msgs.length > 0 && msgs[msgs.length - 1] instanceof Bundle) {
                Bundle d = (Bundle) msgs[msgs.length - 1];
                CharSequence dt = d.getCharSequence("text"), ds = d.getCharSequence("sender");
                if (dt != null) o.put("dernier", dt.toString().length() > 400 ? dt.toString().substring(0, 400) + "…" : dt.toString());
                if (ds != null) o.put("de", ds.toString());
            }
            Notification.Action r = actionReponse(n);
            if (r != null) { o.put("repondre", true); synchronized (reponses) { reponses.put(sbn.getKey(), r); } }
            return o;
        } catch (Exception ex) { return null; }
    }

    /** l'action « Répondre » (champ de texte libre) d'une notification, s'il y en a une */
    static Notification.Action actionReponse(Notification n) {
        java.util.ArrayList<Notification.Action> acts = new java.util.ArrayList<>();
        if (n.actions != null) acts.addAll(java.util.Arrays.asList(n.actions));
        try { acts.addAll(new Notification.WearableExtender(n).getActions()); } catch (Exception ignored) { }
        for (Notification.Action a : acts) {
            RemoteInput[] ri = a.getRemoteInputs();
            if (ri == null || a.actionIntent == null) continue;
            for (RemoteInput x : ri) if (x.getAllowFreeFormInput()) return a;
        }
        return null;
    }

    /** répond à une notification de message, comme le ferait une montre connectée. Renvoie ok / introuvable / erreur */
    static String repondre(Context c, String cle, String texte) {
        Notification.Action a;
        synchronized (reponses) { a = reponses.get(cle); }
        NotifService s = instance;
        if (a == null && s != null) try {
            for (StatusBarNotification sbn : s.getActiveNotifications()) if (sbn.getKey().equals(cle)) a = actionReponse(sbn.getNotification());
        } catch (Exception ignored) { }
        if (a == null) return "introuvable";
        try {
            Intent i = new Intent(); Bundle b = new Bundle();
            for (RemoteInput x : a.getRemoteInputs()) b.putCharSequence(x.getResultKey(), texte);
            RemoteInput.addResultsToIntent(a.getRemoteInputs(), i, b);
            a.actionIntent.send(c, 0, i);
            return "ok";
        } catch (Exception e) { return "erreur"; }
    }

    /** mode voiture : un nouveau message arrive → Claire le lit à voix haute et propose de répondre */
    private void annoncer(JSONObject o) {
        try {
            if (!WakeService.prefs(this).getBoolean("voiture", false)) return;
            if (!MESSAGERIES.contains(o.optString("pkg"))) return;
            String txt = o.optString("dernier", o.optString("texte"));
            if (txt.isEmpty() || txt.equals(dernierTexteAnnonce)) return;
            long now = System.currentTimeMillis();
            if (now - derniereAnnonce < 6000) return;
            AudioManager am = (AudioManager) getSystemService(AUDIO_SERVICE);
            if (am != null && (am.getMode() == AudioManager.MODE_IN_CALL || am.getMode() == AudioManager.MODE_IN_COMMUNICATION || am.getMode() == AudioManager.MODE_RINGTONE)) return;
            derniereAnnonce = now; dernierTexteAnnonce = txt;
            String app = o.optString("app"), qui = o.optString("titre");
            String phrase = "Message " + (app.isEmpty() ? "" : app + " ") + "de " + qui + " : « " + txt + " »." + (o.optBoolean("repondre") ? " Tu veux répondre ?" : "");
            android.app.KeyguardManager k = (android.app.KeyguardManager) getSystemService(KEYGUARD_SERVICE);
            boolean locked = k != null && k.isKeyguardLocked();
            Intent i = new Intent(this, MainActivity.class).putExtra("message", phrase).putExtra("lock", locked).putExtra("jeton", WakeService.jeton(this))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
            startActivity(i);
        } catch (Exception ignored) { }
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        JSONObject o = lire(this, sbn); if (o == null) return;
        boolean nouveau = true;
        synchronized (recues) { for (JSONObject x : recues) if (x.optString("cle").equals(o.optString("cle")) && x.optString("dernier", x.optString("texte")).equals(o.optString("dernier", o.optString("texte")))) nouveau = false; }
        if (nouveau) annoncer(o);
        synchronized (recues) {
            // même notification mise à jour : on remplace
            for (Iterator<JSONObject> it = recues.iterator(); it.hasNext(); ) if (it.next().optString("cle").equals(o.optString("cle")) ) it.remove();
            recues.addFirst(o);
            while (recues.size() > 60) recues.removeLast();
        }
    }

    @Override
    public void onNotificationRemoved(StatusBarNotification sbn) { synchronized (reponses) { reponses.remove(sbn.getKey()); } }

    /** les notifications des dernières minutes, les plus récentes d'abord */
    static String liste(Context c, int minutes) {
        long depuis = System.currentTimeMillis() - Math.max(1, Math.min(minutes, 1440)) * 60000L;
        JSONArray a = new JSONArray();
        java.util.HashSet<String> vues = new java.util.HashSet<>();
        synchronized (recues) {
            for (JSONObject o : recues) if (o.optLong("t") >= depuis && vues.add(o.optString("cle"))) a.put(o);
        }
        NotifService s = instance;   // celles encore affichées (reçues avant le démarrage du service)
        if (s != null) try {
            for (StatusBarNotification sbn : s.getActiveNotifications()) {
                JSONObject o = lire(c, sbn);
                if (o != null && o.optLong("t") >= depuis && vues.add(o.optString("cle"))) a.put(o);
            }
        } catch (Exception ignored) { }
        return a.toString();
    }
}
