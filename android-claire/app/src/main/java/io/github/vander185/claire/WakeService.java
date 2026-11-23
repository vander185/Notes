package io.github.vander185.claire;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.Settings;

import org.json.JSONObject;
import org.vosk.Model;
import org.vosk.Recognizer;
import org.vosk.android.RecognitionListener;
import org.vosk.android.SpeechService;
import org.vosk.android.StorageService;

import com.google.androidbrowserhelper.trusted.LauncherActivity;

/**
 * Écoute en continu le mot « Claire », sur le téléphone (modèle Vosk français, hors ligne).
 * Quand il est entendu : le téléphone vibre et l'appli Claire s'ouvre, prête à écouter.
 * Pendant la conversation, l'écoute se met en pause pour laisser le micro à Claire.
 */
public class WakeService extends Service implements RecognitionListener {
    static final String STOP = "stop", CH = "wake", CH_ALERT = "wake_alert";
    static volatile boolean running = false;

    private final Handler h = new Handler(Looper.getMainLooper());
    private Model model;
    private SpeechService speech;
    private long pausedUntil = 0;

    static SharedPreferences prefs(Context c) { return c.getSharedPreferences("claire", MODE_PRIVATE); }

    @Override public IBinder onBind(Intent i) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && STOP.equals(intent.getAction())) {
            prefs(this).edit().putBoolean("wake", false).apply();
            stopSelf();
            return START_NOT_STICKY;
        }
        channels();
        Notification n = notif("Dites « Claire » pour lui parler");
        if (Build.VERSION.SDK_INT >= 29) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        else startForeground(1, n);
        running = true;
        if (model == null) {
            StorageService.unpack(this, "model-fr", "model",
                    m -> { model = m; listen(); },
                    e -> { update("Le réveil vocal n'a pas pu démarrer"); stopSelf(); });
        } else if (speech == null) listen();
        return START_STICKY;
    }

    private void listen() {
        if (model == null || speech != null) return;
        try {
            Recognizer rec = new Recognizer(model, 16000.0f, "[\"claire\", \"[unk]\"]");
            speech = new SpeechService(rec, 16000.0f);
            speech.startListening(this);
        } catch (Exception e) {
            speech = null;
            h.postDelayed(this::listen, 5000);
        }
    }

    private void pauseListening() {
        if (speech != null) { try { speech.stop(); speech.shutdown(); } catch (Exception ignored) { } speech = null; }
    }

    /** Après « Claire » : on laisse le micro à la conversation, puis on reprend quand plus personne ne l'utilise. */
    private void resumeWhenFree(int tries) {
        if (!running) return;
        boolean busy = false;
        try {
            AudioManager am = (AudioManager) getSystemService(AUDIO_SERVICE);
            if (Build.VERSION.SDK_INT >= 24) busy = !am.getActiveRecordingConfigurations().isEmpty();
        } catch (Exception ignored) { }
        if ((busy || System.currentTimeMillis() < pausedUntil) && tries < 400) { h.postDelayed(() -> resumeWhenFree(tries + 1), 3000); return; }
        update("Dites « Claire » pour lui parler");
        listen();
    }

    private void heard(String json) {
        String t = "";
        try { JSONObject o = new JSONObject(json); t = o.optString("text", o.optString("partial", "")); } catch (Exception ignored) { }
        if (!t.contains("claire") || System.currentTimeMillis() < pausedUntil) return;
        pausedUntil = System.currentTimeMillis() + 8000;
        pauseListening();
        try {
            Vibrator v = (Vibrator) getSystemService(VIBRATOR_SERVICE);
            if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createOneShot(70, 200)); else v.vibrate(70);
        } catch (Exception ignored) { }
        try {   // allume l'écran un instant
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            @SuppressWarnings("deprecation") PowerManager.WakeLock wl = pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP, "claire:wake");
            wl.acquire(6000);
        } catch (Exception ignored) { }
        openClaire();
        update("Claire vous écoute…");
        h.postDelayed(() -> resumeWhenFree(0), 8000);
    }

    private Intent talkIntent() {
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(getString(R.string.launch_url) + "?talk=1"), this, LauncherActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return i;
    }

    private void openClaire() {
        boolean canOpen = Build.VERSION.SDK_INT < 29 || Settings.canDrawOverlays(this);
        if (canOpen) { try { startActivity(talkIntent()); return; } catch (Exception ignored) { } }
        // sinon : notification à toucher
        PendingIntent pi = PendingIntent.getActivity(this, 2, talkIntent(), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CH_ALERT) : new Notification.Builder(this);
        b.setSmallIcon(R.drawable.ic_mic).setContentTitle("Claire").setContentText("Touchez pour parler à Claire")
                .setContentIntent(pi).setAutoCancel(true).setCategory(Notification.CATEGORY_CALL).setFullScreenIntent(pi, true);
        if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_MAX);
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(2, b.build());
    }

    private void channels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        NotificationChannel c = new NotificationChannel(CH, "Réveil vocal", NotificationManager.IMPORTANCE_LOW);
        c.setDescription("Indique que Claire attend son prénom"); c.setShowBadge(false);
        nm.createNotificationChannel(c);
        NotificationChannel a = new NotificationChannel(CH_ALERT, "Claire vous écoute", NotificationManager.IMPORTANCE_HIGH);
        nm.createNotificationChannel(a);
    }

    private Notification notif(String text) {
        Intent open = new Intent(this, LauncherActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent pOpen = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE);
        PendingIntent pStop = PendingIntent.getService(this, 1, new Intent(this, WakeService.class).setAction(STOP), PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CH) : new Notification.Builder(this);
        b.setSmallIcon(R.drawable.ic_mic).setContentTitle("Claire").setContentText(text).setOngoing(true).setContentIntent(pOpen)
                .addAction(new Notification.Action.Builder(null, "Arrêter l'écoute", pStop).build());
        return b.build();
    }

    private void update(String text) {
        try { ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(1, notif(text)); } catch (Exception ignored) { }
    }

    @Override public void onPartialResult(String hypothesis) { heard(hypothesis); }
    @Override public void onResult(String hypothesis) { heard(hypothesis); }
    @Override public void onFinalResult(String hypothesis) { heard(hypothesis); }
    @Override public void onError(Exception e) { pauseListening(); h.postDelayed(this::listen, 3000); }
    @Override public void onTimeout() { pauseListening(); listen(); }

    @Override
    public void onDestroy() {
        running = false;
        h.removeCallbacksAndMessages(null);
        pauseListening();
        if (model != null) { try { model.close(); } catch (Exception ignored) { } model = null; }
        super.onDestroy();
    }
}
