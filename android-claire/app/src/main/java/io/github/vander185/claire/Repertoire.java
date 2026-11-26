package io.github.vander185.claire;

import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.ContactsContract;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/** Le répertoire du téléphone : chercher un contact par son nom, et lancer un appel WhatsApp. */
public class Repertoire {
    static final String WA_VOIX = "vnd.android.cursor.item/vnd.com.whatsapp.voip.call";
    static final String WA_VIDEO = "vnd.android.cursor.item/vnd.com.whatsapp.video.call";

    static String simple(String s) {
        if (s == null) return "";
        return Normalizer.normalize(s, Normalizer.Form.NFD).replaceAll("\\p{M}+", "").toLowerCase().replaceAll("[^a-z0-9\\u0600-\\u06ff ]", " ").replaceAll("\\s+", " ").trim();
    }

    /** contacts dont le nom correspond à la recherche, les meilleurs d'abord (au plus 8) */
    static String chercher(Context c, String q) {
        JSONArray out = new JSONArray();
        String sq = simple(q);
        if (sq.isEmpty()) return out.toString();
        String[] mots = sq.split(" ");
        Map<Long, JSONObject> trouves = new LinkedHashMap<>();
        Map<Long, Integer> scores = new HashMap<>();
        try (Cursor k = c.getContentResolver().query(ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                new String[]{ContactsContract.CommonDataKinds.Phone.CONTACT_ID, ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                        ContactsContract.CommonDataKinds.Phone.NUMBER, ContactsContract.CommonDataKinds.Phone.TYPE,
                        ContactsContract.CommonDataKinds.Phone.IS_SUPER_PRIMARY}, null, null, null)) {
            if (k == null) return out.toString();
            while (k.moveToNext()) {
                long id = k.getLong(0);
                String nom = k.getString(1), num = k.getString(2);
                if (nom == null || num == null) continue;
                String sn = simple(nom);
                int score = 0;
                if (sn.equals(sq)) score = 100;
                else {
                    boolean tous = true;
                    String[] ws = sn.split(" ");
                    for (String m : mots) {
                        boolean ok = false;
                        for (String w : ws) if (w.startsWith(m)) { ok = true; break; }
                        if (!ok && !sn.contains(m)) { tous = false; break; }
                        if (ok) score += 10; else score += 3;
                    }
                    if (!tous) continue;
                    if (sn.startsWith(sq)) score += 20;
                }
                JSONObject o = trouves.get(id);
                if (o == null) {
                    o = new JSONObject();
                    o.put("id", id); o.put("nom", nom); o.put("numeros", new JSONArray());
                    trouves.put(id, o); scores.put(id, score);
                }
                JSONArray nums = o.getJSONArray("numeros");
                String propre = num.replaceAll("[^\\d+]", "");
                boolean deja = false;
                for (int i = 0; i < nums.length(); i++) if (nums.getJSONObject(i).getString("num").replaceAll("[^\\d+]", "").equals(propre)) deja = true;
                if (!deja) {
                    JSONObject n = new JSONObject();
                    n.put("num", num);
                    n.put("type", ContactsContract.CommonDataKinds.Phone.getTypeLabel(c.getResources(), k.getInt(3), "").toString());
                    n.put("principal", k.getInt(4) > 0);
                    nums.put(n);
                }
            }
        } catch (Exception e) { return out.toString(); }
        List<Long> ids = new ArrayList<>(trouves.keySet());
        ids.sort((a, b) -> scores.get(b) - scores.get(a));
        if (ids.size() > 8) ids = ids.subList(0, 8);
        // WhatsApp : lignes d'appel voix / vidéo ajoutées par WhatsApp aux contacts qui l'utilisent
        for (Long id : ids) {
            JSONObject o = trouves.get(id);
            try (Cursor w = c.getContentResolver().query(ContactsContract.Data.CONTENT_URI,
                    new String[]{ContactsContract.Data._ID, ContactsContract.Data.MIMETYPE},
                    ContactsContract.Data.CONTACT_ID + "=? AND " + ContactsContract.Data.MIMETYPE + " IN (?,?)",
                    new String[]{String.valueOf(id), WA_VOIX, WA_VIDEO}, null)) {
                while (w != null && w.moveToNext()) o.put(WA_VOIX.equals(w.getString(1)) ? "wa_voix" : "wa_video", w.getLong(0));
            } catch (Exception ignored) { }
            out.put(o);
        }
        return out.toString();
    }

    /** lance un appel WhatsApp (voix ou vidéo) avec la ligne trouvée par chercher() */
    static boolean appelWhatsApp(Context c, long dataId, boolean video) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(Uri.withAppendedPath(ContactsContract.Data.CONTENT_URI, String.valueOf(dataId)), video ? WA_VIDEO : WA_VOIX)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(i);
            return true;
        } catch (Exception e) { return false; }
    }
}
