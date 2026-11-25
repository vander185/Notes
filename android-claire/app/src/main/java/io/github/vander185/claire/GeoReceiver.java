package io.github.vander185.claire;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.os.Build;

import org.json.JSONObject;

/** Rappels selon le lieu : « quand j'arrive au snack… », « quand je quitte le travail… » */
public class GeoReceiver extends BroadcastReceiver {
    static SharedPreferences prefs(Context c) { return c.getSharedPreferences("claire_geo", Context.MODE_PRIVATE); }

    static PendingIntent pi(Context c, String id) {
        Intent i = new Intent(c, GeoReceiver.class).setAction("geo:" + id);
        int f = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);   // le système ajoute « entrée / sortie »
        return PendingIntent.getBroadcast(c, ("geo:" + id).hashCode(), i, f);
    }

    static boolean ajouter(Context c, String id, double lat, double lon, float rayon, boolean arrivee, String texte, String lieu) {
        if (c.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) return false;
        try {
            JSONObject o = new JSONObject().put("lat", lat).put("lon", lon).put("r", rayon).put("arrivee", arrivee).put("texte", texte).put("lieu", lieu);
            prefs(c).edit().putString(id, o.toString()).apply();
            poser(c, id, o);
            return true;
        } catch (Exception e) { return false; }
    }

    @SuppressWarnings("MissingPermission")
    static void poser(Context c, String id, JSONObject o) {
        if (c.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) return;
        LocationManager lm = (LocationManager) c.getSystemService(Context.LOCATION_SERVICE);
        lm.addProximityAlert(o.optDouble("lat"), o.optDouble("lon"), (float) o.optDouble("r", 150), -1, pi(c, id));
    }

    static void retirer(Context c, String id) {
        try { ((LocationManager) c.getSystemService(Context.LOCATION_SERVICE)).removeProximityAlert(pi(c, id)); } catch (Exception ignored) { }
        prefs(c).edit().remove(id).apply();
    }

    /** après un redémarrage, le système oublie les alertes : on les remet */
    static void reposerTout(Context c) {
        for (String id : prefs(c).getAll().keySet()) try { poser(c, id, new JSONObject(prefs(c).getString(id, "{}"))); } catch (Exception ignored) { }
    }

    @Override
    public void onReceive(Context c, Intent in) {
        String a = in.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(a) || "android.intent.action.MY_PACKAGE_REPLACED".equals(a)) { reposerTout(c); return; }
        if (a == null || !a.startsWith("geo:")) return;
        String id = a.substring(4);
        String s = prefs(c).getString(id, null); if (s == null) return;
        boolean entre = in.getBooleanExtra(LocationManager.KEY_PROXIMITY_ENTERING, true);
        try {
            JSONObject o = new JSONObject(s);
            if (o.optBoolean("arrivee", true) != entre) return;   // pas le bon sens (on attend l'arrivée ou le départ)
            retirer(c, id);   // une seule fois
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (Build.VERSION.SDK_INT >= 26) { NotificationChannel ch = new NotificationChannel(ReminderReceiver.CH, "Rappels", NotificationManager.IMPORTANCE_HIGH); ch.enableVibration(true); nm.createNotificationChannel(ch); }
            PendingIntent open = PendingIntent.getActivity(c, 6, new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE);
            Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, ReminderReceiver.CH) : new Notification.Builder(c);
            String t = o.optString("texte", "Rappel");
            b.setSmallIcon(R.drawable.ic_mic).setContentTitle("📍 " + (entre ? "Tu es arrivé : " : "Tu pars de : ") + o.optString("lieu", "lieu"))
                    .setContentText(t).setStyle(new Notification.BigTextStyle().bigText(t)).setContentIntent(open).setAutoCancel(true).setCategory(Notification.CATEGORY_REMINDER);
            if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);
            nm.notify(("geo:" + id).hashCode(), b.build());
        } catch (Exception ignored) { }
    }
}
