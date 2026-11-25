/* ==========================================================================
   Lecture du texte des scans (OCR), comme Adobe Scan.
   Tout se fait sur le téléphone avec Tesseract (fichiers dans /ocr, chargés
   seulement la première fois qu'on en a besoin) : aucune image n'est envoyée.
   ========================================================================== */
(() => {
'use strict';
let W = null;
const base = new URL('ocr/', location.href).href;
function charger() {
  if (window.Tesseract) return Promise.resolve();
  return new Promise((ok, ko) => { const s = document.createElement('script'); s.src = base + 'tesseract.min.js'; s.onload = ok; s.onerror = () => ko(new Error('ocr')); document.head.appendChild(s); });
}
async function worker(prog) {
  if (W) return W;
  await charger();
  W = await Tesseract.createWorker('fra', 1, {   // 1 = moteur LSTM (le plus précis)
    workerPath: base + 'worker.min.js', corePath: base, langPath: base, gzip: true, workerBlobURL: false,
    cacheMethod: 'write', logger: m => prog && m.status === 'loading language traineddata' && prog(-1)
  });
  return W;
}
/** lit le texte d'une liste de canvas ; prog(i, n) pendant la lecture */
window.ocrPages = async (canvases, prog) => {
  const w = await worker(prog), out = [];
  for (let i = 0; i < canvases.length; i++) {
    prog && prog(i + 1, canvases.length);
    const { data } = await w.recognize(canvases[i]);
    out.push((data.text || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim());
  }
  return out;
};
window.ocrFin = async () => { if (W) { try { await W.terminate(); } catch (e) {} W = null; } };
})();
