package io.github.vander185.claire;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.provider.Settings;
import android.app.KeyguardManager;

/** Rappel à l'heure prévue, même si Claire est fermée */
public class ReminderReceiver extends BroadcastReceiver {
    static final String CH = "rappels";

    static PendingIntent pending(Context c, String id, String text) {
        Intent i = new Intent(c, ReminderReceiver.class).setAction("rappel:" + id).putExtra("text", text);
        return PendingIntent.getBroadcast(c, id.hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** rappel de prière annoncé à voix haute par Claire */
    static PendingIntent priere(Context c, String id, String text) {
        Intent i = new Intent(c, ReminderReceiver.class).setAction("priere:" + id).putExtra("text", text).putExtra("voix", true);
        return PendingIntent.getBroadcast(c, ("priere:" + id).hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    @Override
    public void onReceive(Context c, Intent in) {
        if (in.getBooleanExtra("voix", false)) {
            // Claire ouvre l'appli et dit le message avec sa voix (même téléphone verrouillé)
            KeyguardManager k = (KeyguardManager) c.getSystemService(Context.KEYGUARD_SERVICE);
            boolean locked = k != null && k.isKeyguardLocked();
            Intent a = new Intent(c, MainActivity.class).putExtra("annonce", in.getStringExtra("text")).putExtra("lock", locked)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            boolean canOpen = Build.VERSION.SDK_INT < 29 || Settings.canDrawOverlays(c);
            if (canOpen) { try { c.startActivity(a); } catch (Exception ignored) { } }
        }
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CH, "Rappels", NotificationManager.IMPORTANCE_HIGH);
            ch.enableVibration(true);
            nm.createNotificationChannel(ch);
        }
        PendingIntent open = PendingIntent.getActivity(c, 5, new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, CH) : new Notification.Builder(c);
        String text = in.getStringExtra("text");
        b.setSmallIcon(R.drawable.ic_mic).setContentTitle(in.getBooleanExtra("voix", false) ? "🕌 Prière" : "Rappel de Claire").setContentText(text == null ? "Rappel" : text)
                .setStyle(new Notification.BigTextStyle().bigText(text == null ? "Rappel" : text))
                .setContentIntent(open).setAutoCancel(true).setCategory(Notification.CATEGORY_REMINDER);
        if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);
        nm.notify(("rappel:" + in.getAction()).hashCode(), b.build());
    }
}
