package io.github.vander185.claire;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;

/** Widget de l'écran d'accueil : « Parler à Claire » et le prochain rendez-vous */
public class ClaireWidget extends AppWidgetProvider {
    @Override
    public void onUpdate(Context c, AppWidgetManager m, int[] ids) { maj(c, m, ids); }

    static void majTout(Context c) {
        AppWidgetManager m = AppWidgetManager.getInstance(c);
        maj(c, m, m.getAppWidgetIds(new ComponentName(c, ClaireWidget.class)));
    }

    static void maj(Context c, AppWidgetManager m, int[] ids) {
        String txt = WakeService.prefs(c).getString("widget_txt", "Touche pour parler à Claire");
        Intent parler = new Intent(c, MainActivity.class).putExtra("talk", true).putExtra("jeton", WakeService.jeton(c))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pp = PendingIntent.getActivity(c, 11, parler, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent ouvrir = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent po = PendingIntent.getActivity(c, 12, ouvrir, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        for (int id : ids) {
            RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget);
            v.setTextViewText(R.id.w_txt, txt);
            v.setOnClickPendingIntent(R.id.w_mic, pp);
            v.setOnClickPendingIntent(R.id.w_body, po);
            m.updateAppWidget(id, v);
        }
    }
}
