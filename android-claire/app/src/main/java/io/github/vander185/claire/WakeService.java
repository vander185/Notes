package io.github.vander185.claire;

import android.app.KeyguardManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.Settings;

import org.json.JSONArray;
import org.json.JSONObject;
import org.vosk.Model;
import org.vosk.Recognizer;
import org.vosk.SpeakerModel;
import org.vosk.android.StorageService;

/**
 * Écoute en continu le mot « Claire », sur le téléphone (modèle Vosk français, hors ligne).
 * Quand il est entendu : vibration, l'écran s'allume, Claire s'ouvre et écoute.
 *
 * Empreinte vocale : « Claire » est un mot très court (moins d'une demi-seconde), trop court
 * pour que Vosk calcule une empreinte de voix. On garde donc les 4 dernières secondes de son,
 * on découpe le mot « Claire » et on le répète plusieurs fois avant de calculer l'empreinte.
 */
public class WakeService extends Service {
    static final String STOP = "stop", CH = "wake", CH_ALERT = "wake_alert";
    static volatile boolean running = false;
    static volatile WakeService instance;
    static final int ENROLL_N = 6;
    private static final int RATE = 16000;
    private static final String GRAMMAR = "[\"claire\", \"[unk]\"]";

    private final Handler h = new Handler(Looper.getMainLooper());
    private Model model;
    private SpeakerModel spk;
    private volatile boolean enrolling = false;
    private final java.util.ArrayList<double[]> samples = new java.util.ArrayList<>();
    private volatile long pausedUntil = 0;

    /* lecture du micro */
    private volatile Thread loop;
    private volatile boolean listening = false;
    private final short[] ring = new short[RATE * 4];   // 4 dernières secondes
    private long total = 0;                               // échantillons lus depuis le début de l'écoute
    private long skipped = 0;                             // échantillons non envoyés à la reconnaissance (pauses)

    static SharedPreferences prefs(Context c) { return c.getSharedPreferences("claire", MODE_PRIVATE); }
    /** jeton secret propre au téléphone : seules les demandes venant de Claire elle-même le connaissent
     *  (une autre appli ne peut donc pas ouvrir Claire par-dessus l'écran verrouillé ni lui faire dire un texte) */
    static String jeton(Context c) {
        SharedPreferences p = prefs(c); String j = p.getString("jeton", null);
        if (j == null) { j = java.util.UUID.randomUUID().toString(); p.edit().putString("jeton", j).apply(); }
        return j;
    }
    static boolean jetonOk(Context c, android.content.Intent i) {
        String j = i == null ? null : i.getStringExtra("jeton");
        return j != null && j.equals(jeton(c));
    }

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
                        new Thread(() -> {   // modèle d'empreinte vocale
                            try { java.io.File d = copyAssets("model-spk"); spk = new SpeakerModel(d.getAbsolutePath()); } catch (Throwable ignored) { spk = null; }
                            h.post(this::listen);
                        }).start();
                    },
                    e -> { update("Le réveil vocal n'a pas pu démarrer"); stopSelf(); });
        } else listen();
        return START_STICKY;
    }

    /* ---------- écoute ---------- */
    private synchronized void listen() {
        if (model == null || listening || !running) return;
        listening = true;
        loop = new Thread(this::run, "claire-wake");
        loop.start();
    }

    private void stopListening() { listening = false; }

    private void run() {
        AudioRecord rec = null; Recognizer r = null;
        try {
            int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            rec = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, RATE));
            if (rec.getState() != AudioRecord.STATE_INITIALIZED) throw new IllegalStateException("micro");
            r = new Recognizer(model, RATE, GRAMMAR);
            r.setWords(true);
            total = 0; skipped = 0;
            rec.startRecording();
            short[] buf = new short[RATE / 10];
            while (listening && running) {
                int n = rec.read(buf, 0, buf.length);
                if (n <= 0) continue;
                synchronized (ring) {
                    for (int i = 0; i < n; i++) ring[(int) ((total + i) % ring.length)] = buf[i];
                    total += n;
                }
                if (System.currentTimeMillis() < pausedUntil) { skipped += n; continue; }
                if (r.acceptWaveForm(buf, n)) onFinal(r.getResult());
                else onPartial(r.getPartialResult());
            }
        } catch (Throwable e) {
            if (running) h.postDelayed(this::listen, 3000);
        } finally {
            listening = false;
            if (rec != null) { try { rec.stop(); } catch (Exception ignored) { } rec.release(); }
            if (r != null) { try { r.close(); } catch (Exception ignored) { } }
        }
    }

    private void onPartial(String json) {
        if (enrolling || voicePrint() != null) return;   // avec empreinte, on attend la fin du mot
        String t = "";
        try { t = new JSONObject(json).optString("partial", ""); } catch (Exception ignored) { }
        if (t.contains("claire")) { voiceOk(false); trigger(); }
    }

    private void onFinal(String json) {
        double start = -1, end = -1;
        try {
            JSONArray words = new JSONObject(json).optJSONArray("result");
            if (words != null) for (int i = 0; i < words.length(); i++) {
                JSONObject w = words.getJSONObject(i);
                if ("claire".equals(w.optString("word"))) { start = w.getDouble("start"); end = w.getDouble("end"); }
            }
        } catch (Exception ignored) { }
        if (start < 0) return;
        boolean hasPrint = voicePrint() != null;
        if (!enrolling && (!hasPrint || spk == null)) { voiceOk(false); trigger(); return; }
        double[] v = embed(start, end);
        if (enrolling) {
            if (v == null) { msg("Pas bien entendu, redites « Claire »"); return; }
            addSample(v);
            return;
        }
        if (v == null) return;                           // son trop court ou bruit : on ignore
        double sim = cos(v, voicePrint());
        prefs(this).edit().putFloat("last_sim", (float) sim).apply();
        if (sim >= threshold()) {
            // voix d'Ahmed reconnue avec le seuil strict : le téléphone verrouillé peut donner accès à ses données
            voiceOk(sim >= prefs(this).getFloat("vmin", 0.5f) - 0.06);
            trigger();
        }
        else pausedUntil = System.currentTimeMillis() + 1200;   // une autre voix
    }

    /** empreinte du mot entre start et end (secondes depuis le début de l'écoute) */
    private double[] embed(double start, double end) {
        if (spk == null) return null;
        long s0 = (long) ((start - 0.08) * RATE) + skipped, s1 = (long) ((end + 0.08) * RATE) + skipped;
        short[] word;
        synchronized (ring) {
            if (s0 < 0) s0 = 0;
            if (s1 > total) s1 = total;
            if (s1 - s0 < RATE / 10 || total - s0 > ring.length) return null;
            word = new short[(int) (s1 - s0)];
            for (int i = 0; i < word.length; i++) word[i] = ring[(int) ((s0 + i) % ring.length)];
        }
        int gap = RATE / 20, reps = Math.max(3, Math.min(10, (int) Math.ceil(1.2 * RATE / word.length)));
        short[] audio = new short[RATE / 5 + reps * (word.length + gap) + RATE / 5];
        int p = RATE / 5;
        for (int k = 0; k < reps; k++) { System.arraycopy(word, 0, audio, p, word.length); p += word.length + gap; }
        Recognizer v = null;
        try {
            v = new Recognizer(model, RATE, GRAMMAR);
            v.setSpeakerModel(spk);
            v.acceptWaveForm(audio, audio.length);
            JSONArray a = new JSONObject(v.getFinalResult()).optJSONArray("spk");
            if (a == null || a.length() == 0) return null;
            double[] out = new double[a.length()];
            for (int i = 0; i < out.length; i++) out[i] = a.getDouble(i);
            return norm(out);
        } catch (Throwable e) {
            return null;
        } finally {
            if (v != null) { try { v.close(); } catch (Exception ignored) { } }
        }
    }

    private void trigger() {
        pausedUntil = System.currentTimeMillis() + 8000;
        stopListening();
        try {
            Vibrator vb = (Vibrator) getSystemService(VIBRATOR_SERVICE);
            if (Build.VERSION.SDK_INT >= 26) vb.vibrate(VibrationEffect.createOneShot(70, 200)); else vb.vibrate(70);
        } catch (Exception ignored) { }
        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            @SuppressWarnings("deprecation") PowerManager.WakeLock wl = pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP, "claire:wake");
            wl.acquire(6000);
        } catch (Exception ignored) { }
        h.post(() -> { openClaire(); update("Claire vous écoute…"); });
        h.postDelayed(() -> resumeWhenFree(0), 8000);
    }

    /** après « Claire » : on laisse le micro à la conversation, puis on reprend quand il est libre */
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
    static double cos(double[] a, double[] b) { if (a == null || b == null || a.length != b.length) return -1; double s = 0; for (int i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

    double[] voicePrint() {
        String s = prefs(this).getString("voice2", null); if (s == null) return null;
        try { JSONArray a = new JSONArray(s); double[] v = new double[a.length()]; for (int i = 0; i < v.length; i++) v[i] = a.getDouble(i); return v; } catch (Exception e) { return null; }
    }
    double threshold() {
        float base = prefs(this).getFloat("vmin", 0.5f);   // ressemblance la plus faible mesurée pendant l'enregistrement
        boolean strict = prefs(this).getBoolean("strict", true);
        return base - (strict ? 0.06 : 0.16);
    }
    /** mémorise si le dernier réveil vient bien de la voix d'Ahmed (valable une minute, une seule conversation) */
    private void voiceOk(boolean ok) { prefs(this).edit().putLong("vok_at", ok ? System.currentTimeMillis() : 0).apply(); }
    private void msg(String m) { prefs(this).edit().putString("vmsg", m).apply(); }

    void startEnroll() {
        samples.clear(); enrolling = true; pausedUntil = 0;
        prefs(this).edit().putInt("enroll", 0).apply();
        msg(spk == null ? "Le module d'empreinte vocale n'a pas pu démarrer" : "Dites « Claire »");
        update("Enregistrement de votre voix : dites « Claire » (0/" + ENROLL_N + ")");
        listen();
    }
    void cancelEnroll() { enrolling = false; samples.clear(); prefs(this).edit().putInt("enroll", -1).apply(); msg(""); update("Dites « Claire » pour lui parler"); }

    private void addSample(double[] v) {
        samples.add(v);
        prefs(this).edit().putInt("enroll", samples.size()).apply();
        msg(samples.size() < ENROLL_N ? "Bien reçu, encore une fois" : "C'est fait");
        try { Vibrator vb = (Vibrator) getSystemService(VIBRATOR_SERVICE); if (Build.VERSION.SDK_INT >= 26) vb.vibrate(VibrationEffect.createOneShot(40, 150)); else vb.vibrate(40); } catch (Exception ignored) { }
        pausedUntil = System.currentTimeMillis() + 600;
        h.post(() -> update("Enregistrement de votre voix : dites « Claire » (" + samples.size() + "/" + ENROLL_N + ")"));
        if (samples.size() < ENROLL_N) return;
        double[] m = new double[samples.get(0).length];
        for (double[] s : samples) for (int i = 0; i < m.length; i++) m[i] += s[i] / samples.size();
        m = norm(m);
        double min = 1; for (double[] s : samples) min = Math.min(min, cos(s, m));
        JSONArray a = new JSONArray(); for (double x : m) { try { a.put(x); } catch (Exception ignored) { } }
        prefs(this).edit().putString("voice2", a.toString()).remove("voice").putFloat("vmin", (float) Math.max(0.25, min)).putInt("enroll", ENROLL_N + 1).apply();
        enrolling = false;
        h.post(() -> update("Votre voix est enregistrée : Claire ne répond qu'à vous"));
    }

    private Intent talkIntent() {
        KeyguardManager k = (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
        boolean locked = k != null && k.isKeyguardLocked();
        Intent i = new Intent(this, MainActivity.class).putExtra("talk", true).putExtra("lock", locked).putExtra("jeton", jeton(this));
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

    @Override
    public void onDestroy() {
        running = false; instance = null; enrolling = false;
        stopListening();
        h.removeCallbacksAndMessages(null);
        if (model != null) { try { model.close(); } catch (Exception ignored) { } model = null; }
        super.onDestroy();
    }
}
