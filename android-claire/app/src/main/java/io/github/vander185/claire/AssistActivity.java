package io.github.vander185.claire;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;

/**
 * Claire choisie comme « assistant numérique » du téléphone :
 * appui long sur la touche latérale (Samsung), sur le bouton d'accueil, ou balayage depuis un coin
 * → Claire s'ouvre et écoute tout de suite, même par-dessus l'écran verrouillé (sans les réglages).
 */
public class AssistActivity extends Activity {
    @Override
    protected void onCreate(Bundle s) {
        super.onCreate(s);
        if (Build.VERSION.SDK_INT >= 27) setShowWhenLocked(true);
        KeyguardManager k = (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
        boolean locked = k != null && k.isKeyguardLocked();
        Intent i = new Intent(this, MainActivity.class)
            .putExtra("talk", true).putExtra("lock", locked).putExtra("jeton", WakeService.jeton(this))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        try { startActivity(i); } catch (Exception ignored) { }
        finish();
        overridePendingTransition(0, 0);
    }
}
