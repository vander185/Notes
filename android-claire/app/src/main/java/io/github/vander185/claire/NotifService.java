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
import java.util.Iterator;

/**
 * Lecture des notifications reçues (WhatsApp, SMS…) pour que Claire puisse les résumer.
 * Rien n'est envoyé ailleurs : la liste reste dans la mémoire du téléphone (60 dernières, 24 h).
 */
public class NotifService extends NotificationListenerService {
    private static final ArrayDeque<JSONObject> recues = new ArrayDeque<>();
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
            return o;
        } catch (Exception ex) { return null; }
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        JSONObject o = lire(this, sbn); if (o == null) return;
        synchronized (recues) {
            // même notification mise à jour : on remplace
            for (Iterator<JSONObject> it = recues.iterator(); it.hasNext(); ) if (it.next().optString("cle").equals(o.optString("cle")) ) it.remove();
            recues.addFirst(o);
            while (recues.size() > 60) recues.removeLast();
        }
    }

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
