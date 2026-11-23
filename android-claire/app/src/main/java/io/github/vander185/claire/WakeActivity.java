package io.github.vander185.claire;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.widget.Toast;

/**
 * Active ou coupe le réveil vocal. Ouverte depuis l'appli Claire :
 * clairewake://on  → demande le micro, les notifications, l'affichage par-dessus les autres applis, puis démarre l'écoute
 * clairewake://off → arrête l'écoute
 */
public class WakeActivity extends Activity {
    private static final int REQ = 7, REQ_OVERLAY = 8;
    private int step = 0;

    @Override
    protected void onCreate(Bundle s) {
        super.onCreate(s);
        Uri d = getIntent() != null ? getIntent().getData() : null;
        String host = d != null ? d.getHost() : "on";
        if ("off".equals(host)) {
            WakeService.prefs(this).edit().putBoolean("wake", false).apply();
            stopService(new Intent(this, WakeService.class));
            toast("Réveil vocal coupé");
            finish();
            return;
        }
        next();
    }

    /* les autorisations, une par une */
    private void next() {
        step++;
        if (step == 1) {
            java.util.ArrayList<String> p = new java.util.ArrayList<>();
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) p.add(Manifest.permission.RECORD_AUDIO);
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) p.add(Manifest.permission.POST_NOTIFICATIONS);
            if (!p.isEmpty()) { requestPermissions(p.toArray(new String[0]), REQ); return; }
            next(); return;
        }
        if (step == 2) {
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                toast("Sans le micro, Claire ne peut pas entendre son prénom");
                finish(); return;
            }
            if (Build.VERSION.SDK_INT >= 29 && !Settings.canDrawOverlays(this)) {
                toast("Autorisez Claire à « s'afficher par-dessus les autres applis » : elle pourra s'ouvrir quand vous l'appelez");
                try { startActivityForResult(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName())), REQ_OVERLAY); return; } catch (Exception ignored) { }
            }
            next(); return;
        }
        if (step == 3) {   // éviter que le téléphone coupe l'écoute pour économiser la batterie
            try {
                PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
                if (!pm.isIgnoringBatteryOptimizations(getPackageName())) {
                    startActivityForResult(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())), REQ_OVERLAY + 1);
                    return;
                }
            } catch (Exception ignored) { }
            next(); return;
        }
        WakeService.prefs(this).edit().putBoolean("wake", true).apply();
        Intent svc = new Intent(this, WakeService.class);
        try {
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(svc); else startService(svc);
            toast("Réveil vocal activé : dites « Claire »");
        } catch (Exception e) {
            toast("Le réveil vocal n'a pas pu démarrer");
        }
        finish();
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] res) { next(); }

    @Override
    protected void onActivityResult(int code, int result, Intent data) { next(); }

    private void toast(String s) { Toast.makeText(this, s, Toast.LENGTH_LONG).show(); }
}
