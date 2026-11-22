// Page de retour après la connexion Google : renvoie le jeton à l'appli puis se ferme.
'use strict';
(() => {
  const h = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname);   // le jeton ne reste pas dans l'adresse
  const d = { state: h.get('state'), token: h.get('access_token'), exp: +h.get('expires_in') || 3600, error: h.get('error') };
  if (!d.state) { document.getElementById('m').textContent = 'Rien à faire ici.'; return; }
  try { const bc = new BroadcastChannel('notes-oauth'); bc.postMessage(d); setTimeout(() => bc.close(), 1000); } catch (e) {}
  try { if (window.opener) window.opener.postMessage(d, location.origin); } catch (e) {}
  document.getElementById('m').textContent = d.error ? 'Connexion annulée. Vous pouvez fermer cette page.' : 'C’est fait ✅ Revenez à l’appli.';
  setTimeout(() => { try { window.close(); } catch (e) {} }, 400);
})();
