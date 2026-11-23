package io.github.vander185.notes;

import android.Manifest;
import android.app.Activity;
import android.app.PendingIntent;
import android.app.RecoverableSecurityException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import com.google.androidbrowserhelper.trusted.LauncherActivity;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URLDecoder;
import java.util.ArrayList;
import java.util.List;

/**
 * Cache des photos et vidéos dans le coffre Notes, puis efface les originaux de la galerie.
 *
 * 1. Reçoit les fichiers (bouton « Partager » de la galerie, ou bouton « Importer et effacer » de l'appli).
 * 2. En fait d'abord une copie privée (dans l'appli) : rien n'est perdu même si l'effacement est accepté.
 * 3. Demande à Android d'effacer les originaux (une seule confirmation pour tout le lot).
 * 4. Ouvre le coffre avec les copies : elles y sont chiffrées dès l'arrivée.
 * Les copies privées sont effacées automatiquement après 3 jours.
 */
public class ImportActivity extends Activity {
    private static final int REQ_PICK = 1, REQ_DELETE = 2, REQ_PERM = 3;
    private static final long KEEP_MS = 3L * 24 * 3600 * 1000;

    private final ArrayList<Uri> sources = new ArrayList<>();
    private final ArrayList<Uri> copies = new ArrayList<>();
    private boolean askedPermission = false, pickAfterPermission = false;
    private final ArrayList<String> notes = new ArrayList<>(), noteNames = new ArrayList<>();   // notes lues ici, envoyées au bloc-notes par lien direct
    private final ArrayList<Uri> media = new ArrayList<>();   // sources qui sont des photos/vidéos (les seules à effacer)

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        purgeOldCopies();
        Intent in = getIntent();
        String action = in != null ? in.getAction() : null;
        if (Intent.ACTION_SEND.equals(action)) {
            Uri u = in.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) sources.add(u);
            else {
                // texte partagé (ex. Samsung Notes) : on en fait un petit fichier texte pour le bloc-notes
                CharSequence t = in.getCharSequenceExtra(Intent.EXTRA_TEXT);
                String subj = in.getStringExtra(Intent.EXTRA_SUBJECT);
                if (t != null && t.length() > 0) {
                    notes.add((subj != null && !subj.isEmpty() && !t.toString().startsWith(subj) ? subj + "\n" : "") + t); noteNames.add("");
                    openNotes(); return;
                }
            }
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> l = in.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (l != null) sources.addAll(l);
        } else {
            // bouton « Importer et effacer de la galerie » : d'abord l'accès aux photos (pour retrouver les originaux), puis la Galerie
            if (!canReadMedia() && Build.VERSION.SDK_INT >= 23) {
                askedPermission = true; pickAfterPermission = true;
                requestPermissions(mediaPerms(), REQ_PERM);
            } else pickFromGallery();
            return;
        }
        start();
    }

    private String[] mediaPerms() {
        return Build.VERSION.SDK_INT >= 33
                ? new String[]{Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO}
                : new String[]{Manifest.permission.READ_EXTERNAL_STORAGE};
    }

    /* La Galerie du téléphone (grille de photos), pas le gestionnaire de fichiers */
    private void pickFromGallery() {
        Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
        pick.setType("image/*");
        pick.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"image/*", "video/*"});
        pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        pick.addCategory(Intent.CATEGORY_OPENABLE);
        try {
            startActivityForResult(pick, REQ_PICK);
        } catch (Exception e) {
            toast("Impossible d'ouvrir la galerie");
            finish();
        }
    }

    private Uri writeText(String text) {
        try {
            File dir = new File(getCacheDir(), "inbox/" + System.nanoTime());
            if (!dir.mkdirs()) return null;
            File out = new File(dir, "Note.txt");
            try (OutputStream os = new FileOutputStream(out)) { os.write(text.getBytes("UTF-8")); }
            return FileProvider.getUriForFile(this, getPackageName() + ".files", out);
        } catch (Exception e) { return null; }
    }

    private boolean isMedia(Uri u) {
        String t = null;
        try { t = getContentResolver().getType(u); } catch (Exception ignored) { }
        return t != null && (t.startsWith("image/") || t.startsWith("video/"));
    }

    private void start() {
        if (sources.isEmpty()) { finish(); return; }
        boolean anyMedia = false;
        for (Uri u : sources) if (isMedia(u)) { anyMedia = true; break; }
        if (anyMedia) toast(sources.size() > 1 ? "Mise à l'abri de " + sources.size() + " fichiers…" : "Mise à l'abri…");
        else toast(sources.size() > 1 ? "Envoi de " + sources.size() + " notes vers le bloc-notes…" : "Envoi de la note vers le bloc-notes…");
        new Thread(() -> {
            for (Uri u : sources) {
                if (!isMedia(u)) {   // note (Samsung Notes, texte, Word) : lue directement ici
                    String txt = null;
                    try { txt = NoteReader.read(readAll(u), displayName(u), getContentResolver().getType(u)); } catch (Throwable ignored) { }
                    if (txt != null) { notes.add(txt); String dn = displayName(u); noteNames.add(dn != null ? dn : ""); continue; }
                }
                Uri c = copy(u);
                if (c != null) { copies.add(c); if (isMedia(u)) media.add(u); }
            }
            runOnUiThread(() -> {
                if (copies.isEmpty() && !notes.isEmpty()) { openNotes(); return; }
                if (!notes.isEmpty()) {   // mélange notes + photos : les notes suivent le chemin des fichiers
                    for (String n : notes) { Uri f = writeText(n); if (f != null) copies.add(f); }
                    notes.clear();
                }
                if (copies.isEmpty()) { toast("Aucun fichier n'a pu être lu"); finish(); return; }
                if (copies.size() < sources.size()) toast((sources.size() - copies.size()) + " fichier(s) illisible(s) : ils restent sur le téléphone");
                if (media.isEmpty()) { openVault(); return; }   // notes ou documents : rien à effacer
                askDelete();
            });
        }).start();
    }

    /* ---------- Copie privée ---------- */
    private Uri copy(Uri src) {
        ContentResolver cr = getContentResolver();
        String name = displayName(src);
        String type = cr.getType(src);
        if (name == null || name.isEmpty()) {
            String ext = type != null ? MimeTypeMap.getSingleton().getExtensionFromMimeType(type) : null;
            name = "fichier-" + System.currentTimeMillis() + (ext != null ? "." + ext : "");
        }
        File dir = new File(getCacheDir(), "inbox/" + System.nanoTime());
        if (!dir.mkdirs()) return null;
        File out = new File(dir, name.replaceAll("[\\\\/:*?\"<>|]", "_"));
        try (InputStream is = cr.openInputStream(src); OutputStream os = new FileOutputStream(out)) {
            if (is == null) return null;
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = is.read(buf)) > 0) os.write(buf, 0, n);
        } catch (Exception e) {
            return null;
        }
        return FileProvider.getUriForFile(this, getPackageName() + ".files", out);
    }

    private String displayName(Uri u) {
        try (Cursor c = getContentResolver().query(u, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception ignored) { }
        return null;
    }

    private long size(Uri u) {
        try (Cursor c = getContentResolver().query(u, new String[]{OpenableColumns.SIZE}, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getLong(0);
        } catch (Exception ignored) { }
        return -1;
    }

    private void purgeOldCopies() {
        File root = new File(getCacheDir(), "inbox");
        File[] l = root.listFiles();
        if (l == null) return;
        long now = System.currentTimeMillis();
        for (File d : l) {
            if (now - d.lastModified() > KEEP_MS) {
                File[] fs = d.listFiles();
                if (fs != null) for (File f : fs) //noinspection ResultOfMethodCallIgnored
                    f.delete();
                //noinspection ResultOfMethodCallIgnored
                d.delete();
            }
        }
    }

    /* ---------- Retrouver l'original dans la galerie (MediaStore) ---------- */
    private Uri toMedia(Uri u) {
        if (u == null) return null;
        String auth = u.getAuthority();
        if ("media".equals(auth) || "media_picker".equals(auth)) {
            String path = u.getPath() != null ? u.getPath() : "";
            if (!path.contains("picker")) return u;
            // sélecteur de photos d'Android : même numéro que dans la galerie pour les photos du téléphone
            try {
                long id = Long.parseLong(u.getLastPathSegment());
                String t = getContentResolver().getType(u);
                Uri m = ContentUris.withAppendedId(t != null && t.startsWith("video/") ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI : MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id);
                if (!canReadMedia()) return m;   // Android montre de toute façon les photos avant d'effacer
                String a = displayName(u), b = displayName(m);
                if (a != null && a.equals(b)) return m;
            } catch (Exception ignored) { }
            return byNameAndSize(u);
        }
        try {
            if ("com.android.providers.media.documents".equals(auth) && DocumentsContract.isDocumentUri(this, u)) {
                String[] p = DocumentsContract.getDocumentId(u).split(":");
                if (p.length == 2) {
                    long id = Long.parseLong(p[1]);
                    if ("image".equals(p[0])) return ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id);
                    if ("video".equals(p[0])) return ContentUris.withAppendedId(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, id);
                }
            }
            // Google Photos glisse l'adresse de la galerie dans la sienne
            for (String seg : u.getPathSegments()) {
                String d = URLDecoder.decode(seg, "UTF-8");
                if (d.startsWith("content://media/")) return Uri.parse(d);
            }
        } catch (Exception ignored) { }
        return byNameAndSize(u);
    }

    private boolean canReadMedia() {
        if (Build.VERSION.SDK_INT >= 33)
            return checkSelfPermission(Manifest.permission.READ_MEDIA_IMAGES) == PackageManager.PERMISSION_GRANTED
                    && checkSelfPermission(Manifest.permission.READ_MEDIA_VIDEO) == PackageManager.PERMISSION_GRANTED;
        if (Build.VERSION.SDK_INT >= 23)
            return checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
        return true;
    }

    private Uri byNameAndSize(Uri u) {
        if (!canReadMedia()) return null;
        String name = displayName(u);
        long sz = size(u);
        if (name == null) return null;
        Uri files = MediaStore.Files.getContentUri("external");
        String sel = MediaStore.MediaColumns.DISPLAY_NAME + "=?" + (sz > 0 ? " AND " + MediaStore.MediaColumns.SIZE + "=?" : "");
        String[] args = sz > 0 ? new String[]{name, String.valueOf(sz)} : new String[]{name};
        try (Cursor c = getContentResolver().query(files, new String[]{MediaStore.MediaColumns._ID, MediaStore.Files.FileColumns.MEDIA_TYPE}, sel, args, null)) {
            if (c != null && c.moveToFirst()) {
                long id = c.getLong(0);
                int mt = c.getInt(1);
                if (mt == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO) return ContentUris.withAppendedId(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, id);
                return ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id);
            }
        } catch (Exception ignored) { }
        return null;
    }

    /* ---------- Effacer les originaux (Android demande confirmation) ---------- */
    private void askDelete() {
        int unknown = 0;
        List<Uri> found = new ArrayList<>();
        for (Uri s : media) {
            Uri m = toMedia(s);
            if (m != null) found.add(m); else unknown++;
        }
        if (unknown > 0 && !askedPermission && !canReadMedia() && Build.VERSION.SDK_INT >= 23) {
            askedPermission = true;
            requestPermissions(mediaPerms(), REQ_PERM);
            return;
        }
        if (found.isEmpty()) {
            toast("Les originaux n'ont pas été trouvés : supprimez-les vous-même de la galerie");
            openVault();
            return;
        }
        if (unknown > 0) toast(unknown + " original(aux) introuvable(s) : à supprimer vous-même");
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                PendingIntent pi = MediaStore.createDeleteRequest(getContentResolver(), found);
                startIntentSenderForResult(pi.getIntentSender(), REQ_DELETE, null, 0, 0, 0);
                return;
            } catch (Exception e) {
                toast("Effacement impossible : supprimez les originaux vous-même");
                openVault();
                return;
            }
        }
        // Android 10 et plus ancien
        int ok = 0;
        for (Uri m : found) {
            try {
                ok += getContentResolver().delete(m, null, null);
            } catch (Exception e) {
                if (Build.VERSION.SDK_INT >= 29 && e instanceof RecoverableSecurityException) {
                    try {
                        startIntentSenderForResult(((RecoverableSecurityException) e).getUserAction().getActionIntent().getIntentSender(), REQ_DELETE, null, 0, 0, 0);
                        return;
                    } catch (Exception ignored) { }
                }
            }
        }
        toast(ok > 0 ? ok + " original(aux) effacé(s) de la galerie" : "Supprimez les originaux vous-même de la galerie");
        openVault();
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] res) {
        super.onRequestPermissionsResult(code, perms, res);
        if (code != REQ_PERM) return;
        if (pickAfterPermission) { pickAfterPermission = false; pickFromGallery(); }
        else askDelete();
    }

    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code == REQ_PICK) {
            if (result == RESULT_OK && data != null) {
                ClipData cd = data.getClipData();
                if (cd != null) for (int i = 0; i < cd.getItemCount(); i++) sources.add(cd.getItemAt(i).getUri());
                else if (data.getData() != null) sources.add(data.getData());
            }
            if (sources.isEmpty()) { finish(); return; }
            start();
        } else if (code == REQ_DELETE) {
            toast(result == RESULT_OK ? "Originaux effacés de la galerie ✅" : "Originaux gardés dans la galerie");
            openVault();
        }
    }

    /* ---------- Ouvrir le coffre avec les copies (elles y sont chiffrées à l'arrivée) ---------- */
    private void openVault() {
        Intent t = new Intent(this, LauncherActivity.class);
        t.setType("*/*");
        if (copies.size() == 1) {
            t.setAction(Intent.ACTION_SEND);
            t.putExtra(Intent.EXTRA_STREAM, copies.get(0));
        } else {
            t.setAction(Intent.ACTION_SEND_MULTIPLE);
            t.putParcelableArrayListExtra(Intent.EXTRA_STREAM, copies);
        }
        ClipData cd = ClipData.newRawUri("", copies.get(0));
        for (int i = 1; i < copies.size(); i++) cd.addItem(new ClipData.Item(copies.get(i)));
        t.setClipData(cd);
        t.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(t);
        finish();
    }

    private byte[] readAll(Uri u) throws Exception {
        try (InputStream is = getContentResolver().openInputStream(u)) {
            if (is == null) return null;
            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[1 << 16];
            int n;
            long total = 0;
            while ((n = is.read(buf)) > 0) { bo.write(buf, 0, n); total += n; if (total > 64L << 20) return null; }
            return bo.toByteArray();
        }
    }

    /* Ouvre l'appli sur un lien qui contient les notes (#addnote=…) : pas besoin du partage de Chrome */
    private void openNotes() {
        try {
            org.json.JSONArray arr = new org.json.JSONArray();
            long now = System.currentTimeMillis();
            for (int i = 0; i < notes.size(); i++) {
                String nm = i < noteNames.size() ? noteNames.get(i) : "";
                org.json.JSONObject o = new org.json.JSONObject().put("txt", notes.get(i)).put("upd", now).put("name", nm);
                if (nm.toLowerCase().endsWith(".sdocx")) o.put("src", "Samsung Notes");
                arr.put(o);
            }
            String json = new org.json.JSONObject().put("id", Long.toString(now, 36) + Long.toString(System.nanoTime() & 0xffffff, 36)).put("notes", arr).toString();
            String b64 = android.util.Base64.encodeToString(json.getBytes("UTF-8"), android.util.Base64.URL_SAFE | android.util.Base64.NO_WRAP | android.util.Base64.NO_PADDING);
            if (b64.length() > 400000) {   // note énorme : on passe par le chemin des fichiers
                for (String n : notes) { Uri f = writeText(n); if (f != null) copies.add(f); }
                notes.clear();
                if (!copies.isEmpty()) openVault(); else finish();
                return;
            }
            Intent t = new Intent(Intent.ACTION_VIEW, Uri.parse(getString(R.string.launch_url) + "#addnote=" + b64), this, LauncherActivity.class);
            t.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(t);
        } catch (Exception e) {
            toast("La note n'a pas pu être envoyée");
        }
        finish();
    }

    private void toast(String s) { Toast.makeText(this, s, Toast.LENGTH_LONG).show(); }
}
