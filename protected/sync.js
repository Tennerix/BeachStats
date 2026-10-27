// ── SYNCHRONISATION DE L'HISTORIQUE AVEC LE COMPTE ──────────────────────────
// Le localStorage reste la source utilisée par toutes les pages. Ce script
// se contente de recopier l'historique dans le cloud quand l'utilisateur est
// connecté, et de rapatrier les matchs enregistrés depuis ses autres appareils.
// Sans compte (ou hors ligne), rien ne change : tout reste en local.
(function () {
  const HIST_KEY = 'beachstats_history';
  const IDS_KEY = 'beachstats_sync_ids';       // matchs déjà présents dans le cloud
  const REJ_KEY = 'beachstats_sync_rej';       // matchs refusés (cloud plein), non renvoyés tant qu'il n'y a pas de place
  const NOTIFIED_KEY = 'beachstats_sync_warned'; // matchs pour lesquels on a déjà prévenu
  const MAX_BATCH_BYTES = 1500 * 1024;

  const rawSet = Storage.prototype.setItem;
  const rawRemove = Storage.prototype.removeItem;

  const TXT = {
    fr: {
      limit_free: 'Vous avez atteint la limite de stockage de votre compte (%n% matchs). Ce match est conservé uniquement sur cet appareil. Passez à la version Avancées ou Pro pour le sauvegarder aussi dans le cloud.',
      limit_avancees: 'Vous avez atteint la limite de stockage de votre compte (%n% matchs). Ce match est conservé uniquement sur cet appareil. Passez à la version Pro pour le sauvegarder aussi dans le cloud.',
      limit_pro: 'Votre compte a atteint son plafond de stockage. Ce match est conservé uniquement sur cet appareil.',
      offers: 'Voir les offres',
      login: 'Connectez-vous pour sauvegarder vos matchs dans le cloud et les retrouver sur tous vos appareils.',
      login_btn: 'Se connecter',
      info: '%c% / %n% matchs sauvegardés dans le cloud.',
      info_unlimited: '%c% matchs sauvegardés dans le cloud.',
      overflow: '%o% match(s) uniquement sur cet appareil.'
    },
    en: {
      limit_free: 'You have reached your account storage limit (%n% matches). This match is kept on this device only. Upgrade to Advanced or Pro to back it up to the cloud as well.',
      limit_avancees: 'You have reached your account storage limit (%n% matches). This match is kept on this device only. Upgrade to Pro to back it up to the cloud as well.',
      limit_pro: 'Your account has reached its storage cap. This match is kept on this device only.',
      offers: 'See plans',
      login: 'Log in to back up your matches to the cloud and get them on all your devices.',
      login_btn: 'Log in',
      info: '%c% / %n% matches saved to the cloud.',
      info_unlimited: '%c% matches saved to the cloud.',
      overflow: '%o% match(es) on this device only.'
    },
    pt: {
      limit_free: 'Você atingiu o limite de armazenamento da sua conta (%n% partidas). Esta partida fica salva apenas neste dispositivo. Passe para Avançadas ou Pro para guardá-la também na nuvem.',
      limit_avancees: 'Você atingiu o limite de armazenamento da sua conta (%n% partidas). Esta partida fica salva apenas neste dispositivo. Passe para o Pro para guardá-la também na nuvem.',
      limit_pro: 'Sua conta atingiu o limite de armazenamento. Esta partida fica salva apenas neste dispositivo.',
      offers: 'Ver planos',
      login: 'Entre na sua conta para guardar suas partidas na nuvem e vê-las em todos os seus dispositivos.',
      login_btn: 'Entrar',
      info: '%c% / %n% partidas guardadas na nuvem.',
      info_unlimited: '%c% partidas guardadas na nuvem.',
      overflow: '%o% partida(s) apenas neste dispositivo.'
    }
  };
  const BUY_URL = 'https://beachstats.gumroad.com/l/jlcqx';

  function lang() {
    let l = null;
    try { l = localStorage.getItem('beachstats_lang'); } catch (e) {}
    if (!l) {
      const nav = (navigator.language || 'fr').toLowerCase();
      l = nav.startsWith('pt') ? 'pt' : nav.startsWith('en') ? 'en' : 'fr';
    }
    return TXT[l] ? l : 'fr';
  }
  function tr(key, vars) {
    let s = (TXT[lang()] || TXT.fr)[key] || '';
    Object.keys(vars || {}).forEach(k => { s = s.split('%' + k + '%').join(vars[k]); });
    return s;
  }

  function readJSON(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; }
    catch (e) { return fallback; }
  }
  function writeRaw(key, value) {
    try { rawSet.call(localStorage, key, JSON.stringify(value)); return true; }
    catch (e) { return false; }
  }

  const state = { loggedIn: false, email: null, tier: null, limit: null, count: 0, overflow: 0, ready: false };
  let running = false;
  let again = false;
  let timer = null;
  let tryHeld = false; // renvoyer aussi les matchs retenus (si de la place s'est libérée)

  function emitUpdate() {
    renderNotice();
    try { window.dispatchEvent(new CustomEvent('bs-sync-state', { detail: state })); } catch (e) {}
  }

  // ── Messages ──────────────────────────────────────────────────────────────
  function showToast(message, withOffers) {
    let el = document.getElementById('bsSyncToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'bsSyncToast';
      el.style.cssText = 'position:fixed;left:12px;right:12px;bottom:14px;z-index:99999;max-width:520px;margin:0 auto;' +
        'background:#101a33;color:#fff;border:1px solid #f5b800;border-radius:12px;padding:12px 14px;' +
        'font:500 13px/1.45 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.45)';
      document.body.appendChild(el);
    }
    el.innerHTML = '';
    const p = document.createElement('div');
    p.textContent = message;
    el.appendChild(p);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;margin-top:8px;justify-content:flex-end';
    if (withOffers) {
      const a = document.createElement('a');
      a.href = BUY_URL; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = tr('offers');
      a.style.cssText = 'color:#101a33;background:#f5b800;border-radius:8px;padding:6px 12px;text-decoration:none;font-weight:700';
      row.appendChild(a);
    }
    const close = document.createElement('button');
    close.textContent = 'OK';
    close.style.cssText = 'background:transparent;color:#fff;border:1px solid #ffffff55;border-radius:8px;padding:6px 14px;cursor:pointer';
    close.onclick = () => el.remove();
    row.appendChild(close);
    el.appendChild(row);
  }

  function limitMessage() {
    if (state.tier === 'pro') return tr('limit_pro');
    if (state.tier === 'avancees') return tr('limit_avancees', { n: state.limit });
    return tr('limit_free', { n: state.limit });
  }

  // Bandeau permanent affiché dans la page Historique (emplacement #syncNotice)
  function renderNotice() {
    const box = document.getElementById('syncNotice');
    if (!box) return;
    if (!state.ready) { box.innerHTML = ''; return; }
    const css = 'width:100%;box-sizing:border-box;margin:0 0 14px;padding:11px 14px;border-radius:12px;font:500 13px/1.45 system-ui,sans-serif;' +
      'background:#101a33;color:#dfe6f7;border:1px solid #2a3a66';
    if (!state.loggedIn) {
      box.innerHTML = '<div style="' + css + '"><div>' + tr('login') + '</div>' +
        '<a href="/compte?next=/historique" style="display:inline-block;margin-top:8px;color:#101a33;background:#f5b800;' +
        'border-radius:8px;padding:6px 12px;text-decoration:none;font-weight:700">' + tr('login_btn') + '</a></div>';
      return;
    }
    let line = state.limit == null
      ? tr('info_unlimited', { c: state.count })
      : tr('info', { c: state.count, n: state.limit });
    let html = '<div>' + line + '</div>';
    if (state.overflow > 0) {
      html += '<div style="margin-top:4px;color:#f5b800">' + tr('overflow', { o: state.overflow }) + '</div>';
      if (state.tier !== 'pro') {
        html += '<a href="' + BUY_URL + '" target="_blank" rel="noopener" style="display:inline-block;margin-top:8px;' +
          'color:#101a33;background:#f5b800;border-radius:8px;padding:6px 12px;text-decoration:none;font-weight:700">' +
          tr('offers') + '</a>';
      }
    }
    box.innerHTML = '<div style="' + css + '">' + html + '</div>';
  }

  // ── Synchronisation ───────────────────────────────────────────────────────
  async function post(body) {
    const res = await fetch('/api/matches/sync', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (res.status === 401) return { unauthorized: true };
    if (!res.ok) throw new Error('sync ' + res.status);
    return res.json();
  }

  async function whoAmI() {
    try {
      const r = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) return null;
      const d = await r.json();
      return d && d.email ? d.email : null;
    } catch (e) { return undefined; } // hors ligne : on ne change rien
  }

  async function runOnce() {
    const email = await whoAmI();
    if (email === undefined) return false;           // réseau indisponible
    state.ready = true;
    if (!email) {
      state.loggedIn = false; state.email = null;
      emitUpdate();
      return false;
    }
    state.loggedIn = true; state.email = email;

    let saved = readJSON(IDS_KEY, null);
    if (!saved || saved.email !== email) saved = { email, ids: [] };
    const oldSynced = new Set(saved.ids.map(String));

    let local = readJSON(HIST_KEY, []);
    if (!Array.isArray(local)) local = [];
    const localIds = new Set(local.map(m => String(m.id)));

    // Matchs supprimés sur cet appareil depuis la dernière synchro
    const remove = [...oldSynced].filter(id => !localIds.has(id));

    // Matchs pas encore dans le cloud (y compris ceux refusés plus tôt faute de place)
    let rej = readJSON(REJ_KEY, null);
    if (!rej || rej.email !== email) rej = { email, ids: [] };
    const held = new Set(rej.ids.map(String));
    const sendHeld = tryHeld;
    tryHeld = false;
    const unsynced = local.filter(m => m && m.id != null && !oldSynced.has(String(m.id)));
    const pending = unsynced.filter(m => sendHeld || !held.has(String(m.id)))
      .sort((a, b) => Number(a.id) - Number(b.id));
    const upsert = [];
    let bytes = 0;
    for (const m of pending) {
      const size = JSON.stringify(m).length;
      if (upsert.length && bytes + size > MAX_BATCH_BYTES) break;
      upsert.push(m);
      bytes += size;
    }

    const data = await post({ known: [...localIds], upsert, remove });
    if (data.unauthorized) { state.loggedIn = false; emitUpdate(); return false; }

    const cloudIds = new Set((data.ids || []).map(String));
    const removed = new Set(remove);

    // Matchs supprimés depuis un autre appareil : on les retire ici aussi
    let merged = local.filter(m => {
      const id = String(m.id);
      return !(oldSynced.has(id) && !cloudIds.has(id) && !removed.has(id));
    });
    // Matchs venus d'un autre appareil
    const have = new Set(merged.map(m => String(m.id)));
    let added = 0;
    (data.matches || []).forEach(m => {
      if (m && m.id != null && !have.has(String(m.id))) { merged.push(m); have.add(String(m.id)); added++; }
    });

    const changed = added > 0 || merged.length !== local.length;
    if (changed) {
      if (!writeRaw(HIST_KEY, merged)) {
        // stockage local plein : on ne touche à rien, on réessaiera
        return false;
      }
    }
    writeRaw(IDS_KEY, { email, ids: [...cloudIds] });

    const overflowIds = merged.map(m => String(m.id)).filter(id => !cloudIds.has(id));
    state.tier = data.tier;
    state.limit = data.limit;
    state.count = data.count;
    state.overflow = overflowIds.length;

    // Prévenir une seule fois par match refusé
    const warned = new Set(readJSON(NOTIFIED_KEY, []).map(String));
    const fresh = (data.rejected || []).map(String).filter(id => !warned.has(id) && localIds.has(id));
    if (fresh.length) {
      fresh.forEach(id => warned.add(id));
      writeRaw(NOTIFIED_KEY, [...warned].slice(-200));
      showToast(limitMessage(), state.tier !== 'pro');
    }

    const rejectedNow = (data.rejected || []).map(String);
    const stillHeld = sendHeld ? [] : overflowIds.filter(id => held.has(id));
    writeRaw(REJ_KEY, { email, ids: [...new Set(rejectedNow.concat(stillHeld))] });

    emitUpdate();
    if (changed) { try { window.dispatchEvent(new CustomEvent('bs-history-updated')); } catch (e) {} }
    // Il reste des matchs à envoyer (lot trop gros) : on continue tout de suite
    if (pending.length > upsert.length && (data.rejected || []).length === 0) return true;
    // De la place s'est libérée (changement de niveau, match supprimé) : on renvoie les matchs retenus
    const room = data.limit == null ? data.count < 500 : data.count < data.limit;
    const heldLeft = overflowIds.filter(id => held.has(id));
    if (!sendHeld && room && heldLeft.length) { tryHeld = true; return true; }
    return false;
  }

  async function run() {
    if (running) { again = true; return; }
    running = true;
    try {
      for (let i = 0; i < 8; i++) {
        const more = await runOnce();
        if (!more) break;
      }
    } catch (e) {
      console.warn('Synchronisation impossible pour le moment', e);
    } finally {
      running = false;
      if (again) { again = false; schedule(500); }
    }
  }

  function schedule(delay) {
    clearTimeout(timer);
    timer = setTimeout(run, delay == null ? 1500 : delay);
  }

  // Toute écriture de l'historique (nouveau match, suppression, import...)
  // déclenche une synchro, sans avoir à modifier chaque page.
  Storage.prototype.setItem = function (key) {
    const r = rawSet.apply(this, arguments);
    if (this === window.localStorage && key === HIST_KEY) schedule();
    return r;
  };
  Storage.prototype.removeItem = function (key) {
    const r = rawRemove.apply(this, arguments);
    if (this === window.localStorage && key === HIST_KEY) schedule();
    return r;
  };

  window.addEventListener('online', () => schedule(500));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(800); });
  window.addEventListener('storage', e => { if (e.key === HIST_KEY) schedule(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => schedule(300));
  else schedule(300);

  window.BSSync = { run, state, renderNotice };
})();
