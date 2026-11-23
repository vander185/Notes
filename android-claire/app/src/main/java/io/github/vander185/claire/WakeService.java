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
import org.json.JSONArray;
import org.vosk.Model;
import org.vosk.SpeakerModel;
import org.vosk.Recognizer;
import org.vosk.android.RecognitionListener;
import org.vosk.android.SpeechService;
import org.vosk.android.StorageService;

import android.app.KeyguardManager;

/**
 * Écoute en continu le mot « Claire », sur le téléphone (modèle Vosk français, hors ligne).
 * Quand il est entendu : le téléphone vibre et l'appli Claire s'ouvre, prête à écouter.
 * Pendant la conversation, l'écoute se met en pause pour laisser le micro à Claire.
 */
public class WakeService extends Service implements RecognitionListener {
    static final String STOP = "stop", CH = "wake", CH_ALERT = "wake_alert";
    static volatile boolean running = false;
    static volatile WakeService instance;
    static final int ENROLL_N = 6;

    private final Handler h = new Handler(Looper.getMainLooper());
    private Model model;
    private SpeakerModel spk;
    /* empreinte vocale : moyenne des vecteurs de voix d'Ahmed quand il dit « Claire » */
    private volatile boolean enrolling = false;
    private final java.util.ArrayList<double[]> samples = new java.util.ArrayList<>();
    private boolean pendingClaire = false;
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
        instance = this;
        if (model == null) {
            StorageService.unpack(this, "model-fr", "model",
                    m -> {
                        model = m;
                        new Thread(() -> {   // modèle de reconnaissance de la voix (empreinte vocale)
                            try { java.io.File d = copyAssets("model-spk"); spk = new SpeakerModel(d.getAbsolutePath()); } catch (Throwable ignored) { spk = null; }
                            h.post(this::listen);
                        }).start();
                    },
                    e -> { update("Le réveil vocal n'a pas pu démarrer"); stopSelf(); });
        } else if (speech == null) listen();
        return START_STICKY;
    }

    private void listen() {
        if (model == null || speech != null) return;
        try {
            Recognizer rec = new Recognizer(model, 16000.0f, "[\"claire\", \"[unk]\"]");
            if (spk != null) rec.setSpeakerModel(spk);
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

    private void heard(String json, boolean fin) {
        String t = ""; double[] vec = null;
        try {
            JSONObject o = new JSONObject(json);
            t = o.optString("text", o.optString("partial", ""));
            JSONArray a = o.optJSONArray("spk");
            if (a != null && a.length() > 0) { vec = new double[a.length()]; for (int k = 0; k < vec.length; k++) vec[k] = a.getDouble(k); }
        } catch (Exception ignored) { }
        boolean claire = t.contains("claire");
        if (System.currentTimeMillis() < pausedUntil) return;
        if (enrolling) {   // enregistrement de la voix : on collecte, on ne déclenche rien
            if (fin && claire && vec != null) addSample(vec);
            return;
        }
        double[] print = voicePrint();
        if (print == null || spk == null) { if (claire) trigger(); return; }   // pas d'empreinte : tout le monde peut réveiller Claire
        if (!fin) { if (claire) pendingClaire = true; return; }               // on attend la fin du mot pour comparer la voix
        boolean was = pendingClaire || claire; pendingClaire = false;
        if (!was || vec == null) return;
        double sim = cos(norm(vec), print);
        if (sim >= threshold()) trigger();
        else { pausedUntil = System.currentTimeMillis() + 1500; }   // une autre voix : ignorée
    }

    private void trigger() {
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

    /** copie un dossier des ressources de l'appli vers le stockage interne (une seule fois par version) */
    private java.io.File copyAssets(String name) throws java.io.IOException {
        java.io.File dest = new java.io.File(getFilesDir(), name);
        String uuid = read(getAssets().open(name + "/uuid"));
        java.io.File u = new java.io.File(dest, "uuid");
        if (u.exists() && uuid.equals(read(new java.io.FileInputStream(u)))) return dest;
        copyDir(name, dest);
        return dest;
    }
    private void copyDir(String asset, java.io.File dest) throws java.io.IOException {
        String[] list = getAssets().list(asset);
        if (list == null || list.length == 0) {
            dest.getParentFile().mkdirs();
            try (java.io.InputStream in = getAssets().open(asset); java.io.OutputStream out = new java.io.FileOutputStream(dest)) {
                byte[] b = new byte[65536]; int n; while ((n = in.read(b)) > 0) out.write(b, 0, n);
            }
            return;
        }
        dest.mkdirs();
        for (String f : list) copyDir(asset + "/" + f, new java.io.File(dest, f));
    }
    private static String read(java.io.InputStream in) throws java.io.IOException {
        try (in) { java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream(); byte[] b = new byte[4096]; int n; while ((n = in.read(b)) > 0) bo.write(b, 0, n); return bo.toString("UTF-8").trim(); }
    }

    /* ---------- empreinte vocale ---------- */
    static double[] norm(double[] v) { double s = 0; for (double x : v) s += x * x; s = Math.sqrt(s); if (s == 0) return v; double[] r = new double[v.length]; for (int i = 0; i < v.length; i++) r[i] = v[i] / s; return r; }
    static double cos(double[] a, double[] b) { if (a.length != b.length) return -1; double s = 0; for (int i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

    double[] voicePrint() {
        String s = prefs(this).getString("voice", null); if (s == null) return null;
        try { JSONArray a = new JSONArray(s); double[] v = new double[a.length()]; for (int i = 0; i < v.length; i++) v[i] = a.getDouble(i); return v; } catch (Exception e) { return null; }
    }
    double threshold() {
        float base = prefs(this).getFloat("vmin", 0.5f);   // ressemblance la plus faible mesurée pendant l'enregistrement
        boolean strict = prefs(this).getBoolean("strict", true);
        return base - (strict ? 0.05 : 0.15);
    }
    void startEnroll() {
        samples.clear(); enrolling = true; pausedUntil = 0;
        prefs(this).edit().putInt("enroll", 0).apply();
        update("Enregistrement de votre voix : dites « Claire » (0/" + ENROLL_N + ")");
        if (speech == null) listen();
    }
    void cancelEnroll() { enrolling = false; samples.clear(); prefs(this).edit().putInt("enroll", -1).apply(); update("Dites « Claire » pour lui parler"); }
    private void addSample(double[] v) {
        samples.add(norm(v));
        prefs(this).edit().putInt("enroll", samples.size()).apply();
        try { Vibrator vb = (Vibrator) getSystemService(VIBRATOR_SERVICE); if (Build.VERSION.SDK_INT >= 26) vb.vibrate(VibrationEffect.createOneShot(40, 150)); else vb.vibrate(40); } catch (Exception ignored) { }
        pausedUntil = System.currentTimeMillis() + 700;
        update("Enregistrement de votre voix : dites « Claire » (" + samples.size() + "/" + ENROLL_N + ")");
        if (samples.size() < ENROLL_N) return;
        double[] m = new double[samples.get(0).length];
        for (double[] s : samples) for (int i = 0; i < m.length; i++) m[i] += s[i] / samples.size();
        m = norm(m);
        double min = 1; for (double[] s : samples) min = Math.min(min, cos(s, m));
        JSONArray a = new JSONArray(); for (double x : m) { try { a.put(x); } catch (Exception ignored) { } }
        prefs(this).edit().putString("voice", a.toString()).putFloat("vmin", (float) Math.max(0.2, min)).putInt("enroll", ENROLL_N + 1).apply();
        enrolling = false;
        update("Votre voix est enregistrée : Claire ne répond qu'à vous");
    }

    private Intent talkIntent() {
        KeyguardManager k = (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
        boolean locked = k != null && k.isKeyguardLocked();
        Intent i = new Intent(this, MainActivity.class).putExtra("talk", true).putExtra("lock", locked);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
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
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
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

    @Override public void onPartialResult(String hypothesis) { heard(hypothesis, false); }
    @Override public void onResult(String hypothesis) { heard(hypothesis, true); }
    @Override public void onFinalResult(String hypothesis) { heard(hypothesis, true); }
    @Override public void onError(Exception e) { pauseListening(); h.postDelayed(this::listen, 3000); }
    @Override public void onTimeout() { pauseListening(); listen(); }

    @Override
    public void onDestroy() {
        running = false; instance = null; enrolling = false;
        h.removeCallbacksAndMessages(null);
        pauseListening();
        if (model != null) { try { model.close(); } catch (Exception ignored) { } model = null; }
        super.onDestroy();
    }
}
