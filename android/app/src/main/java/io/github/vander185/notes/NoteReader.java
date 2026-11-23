package io.github.vander185.notes;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Lit une note partagée (Samsung Notes .sdocx, texte, Word, HTML) directement dans l'appli Android,
 * pour l'envoyer au bloc-notes sans passer par le partage de Chrome.
 * Format .sdocx décrit par le projet libre « sdocx » (twangodev/sdocx) ; lecture écrite ici.
 */
final class NoteReader {
    private NoteReader() { }

    /** Texte de la note, ou null si rien de lisible. */
    static String read(byte[] b, String name, String mime) {
        if (b == null || b.length == 0) return null;
        String base = name == null ? "" : name.replaceAll("\\.[^.]+$", "");
        String txt = null, title = null;
        try {
            if (b.length > 4 && b[0] == 'P' && b[1] == 'K') {
                Map<String, byte[]> z = unzip(b);
                if (z.containsKey("note.note")) {
                    String[] r = sdocx(z);
                    title = r[0];
                    txt = join(r[0], r[1]);
                } else if (z.containsKey("word/document.xml")) {
                    txt = docx(new String(z.get("word/document.xml"), StandardCharsets.UTF_8));
                }
            } else if (isText(b, name, mime)) {
                txt = new String(b, StandardCharsets.UTF_8);
                if ((mime != null && mime.contains("html")) || (name != null && name.matches("(?i).*\\.html?$"))) txt = html(txt);
            }
        } catch (Throwable e) {
            return null;
        }
        if (txt == null) return null;
        txt = txt.replace("￼", "").replaceAll("\r\n?|[  ]", "\n").replaceAll("\n{3,}", "\n\n").trim();
        if (txt.isEmpty()) return null;
        boolean generic = base.isEmpty() || base.matches("(?i)(note|memo|texte|text|fichier)[-_ ]?\\d*") || base.matches(".*\\d{6,}.*") || base.matches(".*\\d{4}[-_.]\\d{2}[-_.]\\d{2}.*");   // nom automatique (date) : pas un titre
        if ((title == null || title.isEmpty()) && !generic && !txt.toLowerCase().startsWith(base.toLowerCase())) txt = base + "\n" + txt;
        return txt;
    }

    private static String join(String a, String b) {
        if (a == null || a.isEmpty()) return b;
        if (b == null || b.isEmpty()) return a;
        return a + "\n" + b;
    }

    private static boolean isText(byte[] b, String name, String mime) {
        if (mime != null && mime.startsWith("text/")) return true;
        if (name != null && name.matches("(?i).*\\.(txt|md|html?)$")) return true;
        int n = Math.min(b.length, 4096);
        for (int i = 0; i < n; i++) if (b[i] == 0) return false;
        return true;
    }

    private static Map<String, byte[]> unzip(byte[] b) throws Exception {
        Map<String, byte[]> out = new LinkedHashMap<>();
        try (ZipInputStream zi = new ZipInputStream(new ByteArrayInputStream(b))) {
            ZipEntry e;
            byte[] buf = new byte[1 << 15];
            long total = 0;
            while ((e = zi.getNextEntry()) != null) {
                String n = e.getName();
                if (!(n.equals("note.note") || n.endsWith(".page") || n.equals("word/document.xml"))) continue;
                ByteArrayOutputStream bo = new ByteArrayOutputStream();
                int r;
                while ((r = zi.read(buf)) > 0) {
                    bo.write(buf, 0, r);
                    total += r;
                    if (total > 64L << 20) throw new Exception("trop gros");
                }
                out.put(n, bo.toByteArray());
            }
        }
        return out;
    }

    private static String xml(String s) {
        return s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&");
    }

    private static String docx(String x) {
        StringBuilder sb = new StringBuilder();
        Pattern p = Pattern.compile("<w:t(?:\\s[^>]*)?>([^<]*)</w:t>|<w:tab/>|<w:br/>");
        for (String para : x.split("</w:p>")) {
            Matcher m = p.matcher(para);
            while (m.find()) {
                if (m.group(1) != null) sb.append(xml(m.group(1)));
                else sb.append(m.group().contains("tab") ? "\t" : "\n");
            }
            sb.append('\n');
        }
        return sb.toString();
    }

    private static String html(String s) {
        return xml(s.replaceAll("(?i)<(br|/p|/div|/li|/h\\d)[^>]*>", "\n").replaceAll("<[^>]+>", ""));
    }

    /* ---------- Samsung Notes ---------- */

    private static String[] sdocx(Map<String, byte[]> z) {
        byte[] raw = z.get("note.note");
        String title = "", body = "";
        int bodyStart = 0;
        try {
            ByteBuffer d = ByteBuffer.wrap(raw).order(ByteOrder.LITTLE_ENDIAN);
            d.getInt();                                   // en-tête
            d.position(d.position() + 1 + (d.get(d.position()) & 0xff));   // masque 1
            d.position(d.position() + 1 + (d.get(d.position()) & 0xff));   // masque 2
            d.getInt();                                   // version
            int idn = d.getShort() & 0xffff;
            if (idn != 0xffff) d.position(d.position() + idn * 2);
            d.getInt();                                   // révision
            d.getLong(); d.getLong();                     // dates
            d.position(d.position() + 20);                // dimensions, marges, version minimale
            int ts = d.getInt();
            int tp = d.position();
            try { title = textObj(raw, tp, ts); } catch (Throwable ignored) { }
            d.position(tp + ts);
            int bs = d.getInt();
            bodyStart = d.position();
            try { body = textObj(raw, bodyStart, bs); } catch (Throwable ignored) { }
        } catch (Throwable ignored) { }
        title = clean(title);
        body = clean(body);
        if (body.isEmpty()) {
            List<String> runs = runs(raw, bodyStart, false);
            for (Map.Entry<String, byte[]> e : z.entrySet())
                if (e.getKey().endsWith(".page")) runs.addAll(runs(e.getValue(), 0, true));
            StringBuilder sb = new StringBuilder();
            List<String> kept = new ArrayList<>();
            for (String r : runs) {
                String c = clean(r);
                if (c.isEmpty() || c.equals(title)) continue;
                boolean dup = false;
                for (String k : kept) if (k.contains(c)) { dup = true; break; }
                if (dup) continue;
                kept.add(c);
                if (sb.length() > 0) sb.append('\n');
                sb.append(c);
            }
            body = sb.toString();
        }
        return new String[]{title, body};
    }

    private static String clean(String s) {
        return s == null ? "" : s.replace("￼", "").replaceAll("[\r  ]", "\n").replaceAll("\n{3,}", "\n\n").trim();
    }

    /** Objet texte : cadre « base », cadre 6 (forme), cadre 7 (texte) → texte UTF-16. */
    private static String textObj(byte[] b, int start, int len) {
        if (len < 12) return "";
        int end = start + len;
        int q = start;
        int[] fr = null;
        for (int k = 0; k < 3; k++) {
            fr = frame(b, q, end);
            q = fr[0];
        }
        if (fr[1] != 7 || (fr[2] & 1) == 0) return "";
        ByteBuffer f = ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN);
        int flex = fr[3];
        int n = f.getInt(flex + 4);
        if (n < 0 || flex + 8 + n * 2 > end) return "";
        return new String(b, flex + 8, n * 2, StandardCharsets.UTF_16LE);
    }

    /** Renvoie {fin du cadre, type, 1er octet des champs, début des données variables}. */
    private static int[] frame(byte[] b, int q, int end) {
        ByteBuffer d = ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN);
        int size = d.getInt(q);
        if (size < 12 || q + size > end) throw new IllegalStateException("cadre");
        int data = q + 4;
        int kind = d.getShort(data);
        int flexOff = d.getInt(data + 2);
        int h = data + 6;
        int pm = b[h] & 0xff;
        h += 1 + pm;
        int fm = b[h] & 0xff;
        int fields0 = fm > 0 ? (b[h + 1] & 0xff) : 0;
        boolean any = false;
        for (int i = 0; i < fm; i++) if (b[h + 1 + i] != 0) any = true;
        int fixedEnd = (flexOff == 0 && !any) ? size : flexOff;
        return new int[]{q + size, kind, fields0, data + fixedEnd - 4};
    }

    private static final Pattern OK_CHARS = Pattern.compile("^[\\t\\n\\r\\u0020-\\u024F\\u0370-\\u06FF\\u0750-\\u077F\\u1E00-\\u1EFF\\u2000-\\u206F\\u20A0-\\u20CF\\uFFFC]+$");
    private static final Pattern LETTER = Pattern.compile("\\p{L}");
    private static final Pattern UUIDISH = Pattern.compile("(?i)^[0-9a-f-]{20,}$");

    /** Repli : chaînes UTF-16 précédées de leur longueur (u32). */
    private static List<String> runs(byte[] b, int from, boolean strict) {
        List<String> out = new ArrayList<>();
        ByteBuffer d = ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN);
        for (int i = Math.max(0, from); i + 6 <= b.length; i++) {
            long n = d.getInt(i) & 0xffffffffL;
            if (n < 2 || n > 200000 || i + 4 + n * 2 > b.length) continue;
            boolean ok = true;
            for (int j = 0; j < n; j++) {
                int c = d.getShort(i + 4 + j * 2) & 0xffff;
                if (!(c == 9 || c == 10 || c == 13 || c == 0x2028 || c == 0x2029 || c == 0xFFFC
                        || (c >= 0x20 && c < 0xD800) || (c >= 0xE000 && c < 0xFFF0))) { ok = false; break; }
            }
            if (!ok) continue;
            String s = new String(b, i + 4, (int) n * 2, StandardCharsets.UTF_16LE);
            if (!LETTER.matcher(s).find() || UUIDISH.matcher(s).matches()) continue;
            if (!OK_CHARS.matcher(s).matches() && (strict || s.length() < 4 || !s.matches("(?s).*\\s.*"))) continue;
            int letters = 0;
            Matcher m = LETTER.matcher(s);
            while (m.find()) letters++;
            if (letters < 2) continue;
            out.add(s);
            i += 3 + (int) n * 2;
        }
        return out;
    }
}
