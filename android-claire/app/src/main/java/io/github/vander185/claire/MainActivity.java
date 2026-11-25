package io.github.vander185.claire;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlarmManager;
import android.app.KeyguardManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * L'appli Claire : le site dans une vue intégrée, pour pouvoir s'afficher aussi
 * par-dessus l'écran verrouillé quand on dit « Claire ».
 */
public class MainActivity extends Activity {
    static final String BASE = "https://vander185.github.io/claire/";
    private static final int REQ_MIC = 3;
    private WebView web;
    private PermissionRequest pendingReq;
    private boolean lockMode, visible, annonceRetour;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle s) {
        super.onCreate(s);
        getWindow().setStatusBarColor(Color.parseColor("#081030"));
        getWindow().setNavigationBarColor(Color.parseColor("#081030"));
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#081030"));
        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setSupportMultipleWindows(false);
        ws.setAllowFileAccess(false);
        ws.setUserAgentString(ws.getUserAgentString() + " ClaireApp/2");
        web.addJavascriptInterface(new Bridge(), "ClaireApp");
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest req) {
                runOnUiThread(() -> {
                    if (!req.getOrigin().toString().startsWith("https://vander185.github.io")) { req.deny(); return; }
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
                        req.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                    else { pendingReq = req; requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC); }
                });
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                String p = u.getPath() == null ? "" : u.getPath();
                if ("https".equals(u.getScheme()) && "vander185.github.io".equals(u.getHost()) && (p.equals("/claire") || p.startsWith("/claire/"))) {
                    // téléphone verrouillé : pas de réglages (contacts, appels, mémoire)
                    if (lockMode && p.contains("reglages")) return true;
                    return false;
                }
                openOutside(u);
                return true;
            }
        });
        setContentView(web);
        handle(getIntent(), true);
    }

    @Override
    protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        setIntent(i);
        handle(i, false);
    }

    /** talk = commencer à écouter ; lock = téléphone verrouillé (afficher par-dessus) */
    private void handle(Intent i, boolean first) {
        // seules les demandes de Claire elle-même (réveil vocal, rappel de prière) peuvent l'ouvrir sur l'écran verrouillé
        boolean interne = WakeService.jetonOk(this, i);
        boolean talk = interne && i.getBooleanExtra("talk", false);
        String annonce = interne ? i.getStringExtra("annonce") : null;
        if (annonce != null) {   // rappel de prière dit à voix haute
            i.removeExtra("annonce");
            annonceRetour = !visible;   // appli ouverte juste pour l'annonce : elle se referme après
            lockMode = i.getBooleanExtra("lock", false);
            setLock(lockMode);
            if (first) web.loadUrl(BASE + "?annonce=" + Uri.encode(annonce) + (lockMode ? "&lock=1" : ""));
            else web.evaluateJavascript("window.claireAnnonce && window.claireAnnonce(" + org.json.JSONObject.quote(annonce) + "," + lockMode + ")", null);
            return;
        }
        lockMode = talk && i.getBooleanExtra("lock", false);
        setLock(lockMode);
        if (first) web.loadUrl(BASE + (talk ? "?talk=1" + (lockMode ? "&lock=1" : "") : ""));
        else if (talk) web.evaluateJavascript("window.claireTalk && window.claireTalk(" + lockMode + ")", null);
    }

    private void setLock(boolean on) {
        if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(on); setTurnScreenOn(on); }
        else if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    private void openOutside(Uri u) {
        try {
            Intent i;
            if ("intent".equals(u.getScheme())) {
                i = Intent.parseUri(u.toString(), Intent.URI_INTENT_SCHEME);
                // pas de cible précise ni de données cachées, et jamais Claire elle-même
                if (getPackageName().equals(i.getPackage()) || (i.getComponent() != null && getPackageName().equals(i.getComponent().getPackageName()))) return;
                i.setComponent(null); i.setSelector(null); i.replaceExtras((Bundle) null);
            }
            else if ("tel".equals(u.getScheme())) i = new Intent(Intent.ACTION_DIAL, u);
            else i = new Intent(Intent.ACTION_VIEW, u);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Exception ignored) { }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] p, int[] res) {
        if (code == REQ_MIC && pendingReq != null) {
            if (res.length > 0 && res[0] == PackageManager.PERMISSION_GRANTED) pendingReq.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            else pendingReq.deny();
            pendingReq = null;
        }
    }

    @Override protected void onResume() { super.onResume(); visible = true; }
    @Override protected void onPause() { visible = false; super.onPause(); }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (web != null) { web.destroy(); web = null; }
        super.onDestroy();
    }

    /** Ce que la page peut demander au téléphone */
    class Bridge {
        @JavascriptInterface public boolean isLocked() {
            KeyguardManager k = (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
            return k != null && k.isKeyguardLocked();
        }
        /** vrai une seule fois si Claire vient d'être réveillée par la voix d'Ahmed (empreinte vocale reconnue) */
        @JavascriptInterface public boolean takeVoiceOk() {
            android.content.SharedPreferences p = WakeService.prefs(MainActivity.this);
            long t = p.getLong("vok_at", 0);
            p.edit().putLong("vok_at", 0).apply();
            return t > 0 && System.currentTimeMillis() - t < 60000;
        }
        @JavascriptInterface public boolean wakeRunning() { return WakeService.running; }
        @JavascriptInterface public void wake(boolean on) {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse("clairewake://" + (on ? "on" : "off")), MainActivity.this, WakeActivity.class).putExtra("jeton", WakeService.jeton(MainActivity.this));
            startActivity(i);
        }
        /** fin de conversation sur l'écran verrouillé : on revient à l'écran de verrouillage */
        @JavascriptInterface public void done() {
            runOnUiThread(() -> { if (lockMode || annonceRetour) { boolean l = lockMode; lockMode = false; annonceRetour = false; if (l) setLock(false); moveTaskToBack(true); } });
        }
        /* empreinte vocale */
        @JavascriptInterface public boolean voiceReady() { WakeService w = WakeService.instance; return w != null && w.voicePrint() != null; }
        @JavascriptInterface public boolean voiceStored() { return WakeService.prefs(MainActivity.this).getString("voice2", null) != null; }
        @JavascriptInterface public int enrollProgress() { return WakeService.prefs(MainActivity.this).getInt("enroll", -1); }
        @JavascriptInterface public String enrollMessage() { return WakeService.prefs(MainActivity.this).getString("vmsg", ""); }
        @JavascriptInterface public int enrollTotal() { return WakeService.ENROLL_N; }
        @JavascriptInterface public boolean startEnroll() { WakeService w = WakeService.instance; if (w == null) return false; runOnUiThread(w::startEnroll); return true; }
        @JavascriptInterface public void cancelEnroll() { WakeService w = WakeService.instance; if (w != null) runOnUiThread(w::cancelEnroll); }
        @JavascriptInterface public void clearVoice() { WakeService.prefs(MainActivity.this).edit().remove("voice").remove("voice2").remove("vmin").putInt("enroll", -1).apply(); }
        @JavascriptInterface public boolean isStrict() { return WakeService.prefs(MainActivity.this).getBoolean("strict", true); }
        @JavascriptInterface public void setStrict(boolean s) { WakeService.prefs(MainActivity.this).edit().putBoolean("strict", s).apply(); }
        @JavascriptInterface public void reminder(String id, double when, String text) {
            AlarmManager am = (AlarmManager) getSystemService(ALARM_SERVICE);
            PendingIntent pi = ReminderReceiver.pending(MainActivity.this, id, text);
            long t = (long) when;
            try {
                if (Build.VERSION.SDK_INT >= 31 && !am.canScheduleExactAlarms()) am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, t, pi);
                else am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, t, pi);
            } catch (Exception e) { am.set(AlarmManager.RTC_WAKEUP, t, pi); }
        }
        @JavascriptInterface public void prayer(String id, double when, String text) {
            AlarmManager am = (AlarmManager) getSystemService(ALARM_SERVICE);
            PendingIntent pi = ReminderReceiver.priere(MainActivity.this, id, text);
            long t = (long) when;
            try {
                if (Build.VERSION.SDK_INT >= 31 && !am.canScheduleExactAlarms()) am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, t, pi);
                else am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, t, pi);
            } catch (Exception e) { am.set(AlarmManager.RTC_WAKEUP, t, pi); }
        }
        @JavascriptInterface public void cancelPrayer(String id) {
            ((AlarmManager) getSystemService(ALARM_SERVICE)).cancel(ReminderReceiver.priere(MainActivity.this, id, ""));
        }
        @JavascriptInterface public void cancelReminder(String id) {
            ((AlarmManager) getSystemService(ALARM_SERVICE)).cancel(ReminderReceiver.pending(MainActivity.this, id, ""));
        }
    }
}
