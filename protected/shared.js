// ── CODE PARTAGÉ PAR LES PAGES DE COMPTAGE (base, intermédiaire, avancées, pro) ──
// Ne contient que des fonctions strictement identiques d'une page à l'autre.
// Chargé avant le script de chaque page : tout ce qui est ici vit dans le scope global.

function t(key, vars) {
  const dict = I18N[currentLang] || I18N.fr;
  let str = dict[key] !== undefined ? dict[key] : (I18N.fr[key] !== undefined ? I18N.fr[key] : key);
  if (vars) Object.keys(vars).forEach(k => { str = str.replace('{'+k+'}', vars[k]); });
  return str;
}

function onTeamLabelInput(side) {
  const val = document.getElementById('teamLabel' + side).value.slice(0, 24);
  if (side === 'A') teamLabelA = val; else teamLabelB = val;
  saveProgress();
  if (liveShareCode) pushLiveState();
}

// Les noms viennent de l'URL (?j1=...) : on les échappe avant toute insertion
// via innerHTML. Attention : un simple échappement HTML ne suffit PAS à
// protéger un nom inséré à l'intérieur d'un attribut onclick="...'...'"
// (le navigateur décode les entités HTML avant d'exécuter le JS de
// l'attribut, donc un caractère ' ou ) pourrait quand même casser hors de
// la chaîne JS). C'est pourquoi createControlBlock() ci-dessous n'insère
// jamais le nom lui-même dans le onclick : seul un identifiant fixe et sûr
// ('j1'..'j4' ou null), choisi par le code et jamais par l'utilisateur, y
// est placé. Le vrai nom n'est utilisé que comme texte (via escapeHtml) ou
// comme valeur JS normale (jamais recomposé en code).
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// numéro du set affiché quand statsViewMode === 'set'

function diffStats(newer, older) {
  const out = {};
  Object.keys(newer || {}).forEach(k => {
    const nv = newer[k], ov = (older || {})[k];
    if (nv && typeof nv === 'object') {
      out[k] = diffStats(nv, ov || {});
    } else {
      out[k] = (nv || 0) - (ov || 0);
    }
  });
  return out;
}

function getDisplayStats() {
  if (statsViewMode === 'total') return stats;
  const older = setSnapshots[statsViewSetIdx - 2] || {};
  const newer = statsViewSetIdx <= setSnapshots.length ? setSnapshots[statsViewSetIdx - 1] : stats;
  return diffStats(newer, older);
}

// état en attente d'envoi tant que la connexion n'est pas encore ouverte

function genLiveCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans caractères ambigus
  let out = '';
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// Le partage en direct passe par un WebSocket (Durable Object côté serveur)
// plutôt que par des requêtes HTTP répétées : la diffusion vers les
// spectateurs ne coûte rien du tout, quel que soit leur nombre — bien plus
// robuste que l'ancien système à base de KV (quota d'écriture très limité,
// partagé par tous les utilisateurs de l'appli).
function connectLiveSocket() {
  if (!liveShareCode) return;
  if (liveSocket && (liveSocket.readyState === WebSocket.OPEN || liveSocket.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  liveSocket = new WebSocket(proto + '//' + location.host + '/api/live/' + liveShareCode);
  liveSocket.addEventListener('open', () => {
    if (livePendingPayload) { try { liveSocket.send(livePendingPayload); } catch(e) {} livePendingPayload = null; }
  });
  liveSocket.addEventListener('close', () => {
    // Coupure réseau, mise en veille de l'écran... on retente si le partage
    // est toujours actif, sans jamais bloquer la saisie du match.
    if (liveShareCode) setTimeout(connectLiveSocket, 3000);
  });
  liveSocket.addEventListener('error', () => {});
}

function pushLiveState() {
  if (!liveShareCode) return;
  if (liveSharePushDebounceTimer) return;
  liveSharePushDebounceTimer = setTimeout(() => {
    liveSharePushDebounceTimer = null;
    const payload = JSON.stringify(buildLiveState());
    if (liveSocket && liveSocket.readyState === WebSocket.OPEN) {
      try { liveSocket.send(payload); } catch (e) {}
    } else {
      livePendingPayload = payload; // sera envoyé dès la reconnexion
      connectLiveSocket();
    }
  }, 400);
}

function toggleLiveShare() {
  if (liveShareCode) {
    openLiveModal();
    return;
  }
  liveShareCode = genLiveCode();
  document.getElementById('liveShareBtn').classList.add('active');
  connectLiveSocket();
  pushLiveState();
  liveSharePushTimer = setInterval(pushLiveState, 45000);
  openLiveModal();
}

function openLiveModal() {
  const link = window.location.origin + '/live?code=' + liveShareCode;
  document.getElementById('liveLinkInput').value = link;
  document.getElementById('liveModalBackdrop').classList.add('show');
}

function closeLiveModal(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('liveModalBackdrop').classList.remove('show');
}

function copyLiveLink() {
  const input = document.getElementById('liveLinkInput');
  input.select();
  navigator.clipboard?.writeText(input.value).catch(() => {});
  const btn = document.getElementById('liveCopyBtn');
  const original = btn.textContent;
  btn.textContent = t('live_copied');
  setTimeout(() => { btn.textContent = original; }, 1500);
}

function stopLiveShare() {
  if (liveSharePushTimer) { clearInterval(liveSharePushTimer); liveSharePushTimer = null; }
  if (liveSocket) { try { liveSocket.close(); } catch(e) {} liveSocket = null; }
  liveShareCode = null;
  livePendingPayload = null;
  document.getElementById('liveShareBtn').classList.remove('active');
  closeLiveModal();
}

// ── SCORE LOGIC ───────────────────────────────────────────────────────────────
function scoreSnapshot(player) {
  let pp1=p1, pp2=p2;
  if (player === 1) pp1++; else pp2++;
  let ptStr;
  if (inSuperTiebreak || inTiebreak) {
    ptStr = pp1 + '-' + pp2;
  } else {
    let a = TP[Math.min(pp1,3)] || '0';
    let b = TP[Math.min(pp2,3)] || '0';
    if (pp1>=3 && pp2>=3) { a='40'; b='40'; }
    ptStr = a + '-' + b;
  }
  return ptStr + ' · Jeu ' + g1 + '-' + g2 + ' · Set ' + s1 + '-' + s2;
}

// Logique de progression du score (jeu / tie-break / super tie-break),
// commune à un point marqué normalement et à un point ajouté manuellement
// (bouton de rattrapage) — seule la partie "stats" diffère entre les deux.
function advancePoint(player) {
  if (inSuperTiebreak) {
    if (player === 1) p1++; else p2++;
    if ((p1 >= 10 || p2 >= 10) && Math.abs(p1 - p2) >= 2) {
      winSet(player, {a:p1, b:p2});
    } else {
      updateDisplay();
    }
    return;
  }
  if (inTiebreak) {
    if (player === 1) p1++; else p2++;
    if ((p1 >= 7 || p2 >= 7) && Math.abs(p1 - p2) >= 2) {
      winGame(player);
    } else {
      updateDisplay();
    }
    return;
  }
  if (player === 1) p1++; else p2++;
  if (p1 > 3 || p2 > 3) {
    if (p1 > p2) winGame(1); else winGame(2);
  } else {
    updateDisplay();
  }
}

// ── RATTRAPAGE DE SCORE (corrections manuelles) ──────────────────────────
// Pour reprendre un match déjà commencé, ou rattraper un point/jeu oublié,
// sans que ça compte dans les statistiques par coup (aucun type de coup
// n'est demandé, ce n'est pas une vraie action de jeu).
function addManualPoint(player) {
  if (matchOver) return;
  ensureTimerRunning();
  const pending = serverQuestionNeeded();
  if (pending === 'initial') { askInitialServer(); return; }
  if (pending === 'second') { askSecondTeamServer(); return; }
  saveState();
  logEvent(player === 1 ? nameA : nameB, '➕ Point ajouté manuellement');
  advancePoint(player);
}

function addManualGame(player) {
  if (matchOver) return;
  ensureTimerRunning();
  const pending = serverQuestionNeeded();
  if (pending === 'initial') { askInitialServer(); return; }
  if (pending === 'second') { askSecondTeamServer(); return; }
  saveState();
  logEvent(player === 1 ? nameA : nameB, '➕ Jeu ajouté manuellement');
  winGame(player);
}

function removeManualPoint(player) {
  if (matchOver) return;
  saveState();
  if (player === 1) { if (p1 > 0) p1--; } else { if (p2 > 0) p2--; }
  logEvent(player === 1 ? nameA : nameB, '➖ Point retiré manuellement');
  updateDisplay();
}

function removeManualGame(player) {
  if (matchOver) return;
  saveState();
  if (player === 1) { if (g1 > 0) g1--; } else { if (g2 > 0) g2--; }
  if (matchGameCount > 0) matchGameCount--;
  logEvent(player === 1 ? nameA : nameB, '➖ Jeu retiré manuellement');
  updateDisplay();
}

function updateServerBadge() {
  const el = document.getElementById('serverIndicator');
  const server = computeCurrentServer();

  // Balle 🎾 à côté du prénom du joueur qui sert actuellement, dans le
  // tableau de score (en plus du badge dédié ci-dessous).
  ['j1','j2','j3','j4'].forEach(key => {
    const span = document.getElementById('playerName' + key.toUpperCase());
    if (!span) return;
    span.innerHTML = escapeHtml(players[key]) + (server && server.key === key ? '<span class="serving-ball">🎾</span>' : '');
  });

  if (!el) return;
  if (!server || !server.key) { el.style.display = 'none'; return; }
  el.style.display = 'flex';
  el.querySelector('.server-name').textContent = players[server.key] || (server.team === 'A' ? nameA : nameB);
  el.className = 'server-indicator ' + (server.team === 'A' ? 'team-a' : 'team-b');
}

// Retourne ce qui manque avant de pouvoir marquer un point : 'initial' si on
// ne sait même pas quelle équipe sert en premier, 'second' si on connaît la
// 1ère équipe mais pas encore le 1er serveur de l'autre équipe (nécessaire
// dès que le jeu 2 a commencé), sinon null (on peut jouer).
function serverQuestionNeeded() {
  if (!firstServingTeam) return 'initial';
  if (matchGameCount >= 1) {
    const otherKnown = firstServingTeam === 'A' ? serverTeamBFirst : serverTeamAFirst;
    if (!otherKnown) return 'second';
  }
  return null;
}

function buildServerTeamGroup(container, team, keys, onPick) {
  const group = document.createElement('div');
  group.className = 'server-modal-group';
  const label = document.createElement('div');
  label.className = 'server-modal-group-label team-' + team.toLowerCase();
  label.textContent = t('team_prefix') + team;
  group.appendChild(label);
  const row = document.createElement('div');
  row.className = 'server-modal-group-row';
  keys.forEach(key => {
    const btn = document.createElement('button');
    btn.className = 'server-modal-btn team-' + team.toLowerCase();
    btn.textContent = players[key];
    btn.onclick = () => onPick(team, key);
    row.appendChild(btn);
  });
  group.appendChild(row);
  container.appendChild(group);
}

// Changement manuel du serveur (bouton "Changer") : fait défiler le service
// au joueur suivant dans l'ordre de rotation, sans jamais casser la logique
// automatique — la rotation continue normalement à partir de ce nouveau point.
function cycleServerManually() {
  if (!firstServingTeam) { askInitialServer(); return; }

  const nextAdjustment = serverManualAdjustment + 1;
  let tiebreakOffset = 0;
  if (inTiebreak || inSuperTiebreak) {
    const played = p1 + p2;
    tiebreakOffset = played === 0 ? 0 : 1 + Math.floor((played - 1) / 2);
  }
  const turnIndex = matchGameCount + tiebreakOffset + nextAdjustment;
  const residue = ((turnIndex % 4) + 4) % 4;
  const secondTeam = firstServingTeam === 'A' ? 'B' : 'A';
  const nextTeam = (residue % 2 === 0) ? firstServingTeam : secondTeam;
  const nextTeamKnown = nextTeam === 'A' ? serverTeamAFirst : serverTeamBFirst;

  if (!nextTeamKnown) { pendingCycleAdjustment = nextAdjustment; askSecondTeamServer(); return; }

  serverManualAdjustment = nextAdjustment;
  updateServerBadge();
  saveProgress();
}

// ── UNDO ──────────────────────────────────────────────────────────────────────
function undo() {
  if (matchOver) { matchOver=false; document.getElementById('winnerOverlay').classList.remove('show'); }
  if (history.length === 0) return;
  const last = history.pop();
  p1=last.p1; p2=last.p2; g1=last.g1; g2=last.g2; s1=last.s1; s2=last.s2;
  inTiebreak=last.inTiebreak; inSuperTiebreak=last.inSuperTiebreak;
  setHistory=last.setHistory||[];
  stats = JSON.parse(JSON.stringify(last.stats));
  setSnapshots = JSON.parse(JSON.stringify(last.setSnapshots || []));
  if (statsViewMode === 'set' && statsViewSetIdx > setSnapshots.length + 1) {
    statsViewMode = 'total';
  }
  document.getElementById('setPill').innerText = last.pill;
  document.getElementById('statusLabel').innerText = last.status;
  const list = document.getElementById('logList');
  if (list.firstChild) list.removeChild(list.firstChild);
  matchLog.shift();
  updateDisplay();
}

function logEvent(team, msg) {
  const time = new Date().toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'});
  const entry = {team, msg, time};
  const className = 'log-entry event';
  const html = `<span class="dot"></span><span>${time}${team?' — <strong>'+escapeHtml(team)+'</strong>':''} ${msg}</span>`;
  entry._dom = {className, html};
  matchLog.unshift(entry);
  const list = document.getElementById('logList');
  const div = document.createElement('div');
  div.className = className;
  div.innerHTML = html;
  list.prepend(div);
}

function clearProgress() {
  try { localStorage.removeItem(PROGRESS_KEY); } catch(e) {}
}

function loadProgress() {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw);
    if (snap.p1===0 && snap.p2===0 && snap.g1===0 && snap.g2===0 && snap.s1===0 && snap.s2===0) return null;
    return snap;
  } catch(e) { return null; }
}

function rebuildLog() {
  const list = document.getElementById('logList');
  list.innerHTML = '';
  matchLog.forEach(entry => {
    if (!entry._dom) return;
    const div = document.createElement('div');
    div.className = entry._dom.className;
    div.innerHTML = entry._dom.html;
    list.appendChild(div);
  });
}

function confirmResume() {
  const snap = loadProgress();
  document.getElementById('resumeOverlay').classList.remove('show');
  if (snap) applyProgress(snap);
}

function checkResumeOnLoad() {
  const snap = loadProgress();
  if (!snap) return;
  const matchup = (snap.nameA || nameA) + ' vs ' + (snap.nameB || nameB);
  document.getElementById('resumeMatchup').textContent = matchup;
  document.getElementById('resumeScoreInfo').textContent = t('resume_sets_games', {s1: snap.s1, s2: snap.s2, g1: snap.g1, g2: snap.g2});
  document.getElementById('resumeOverlay').classList.add('show');
}

function embedTitleFont(doc) {
  try {
    doc.addFileToVFS('BarlowCondensed-Black.ttf', BARLOW_BLACK_B64);
    doc.addFont('BarlowCondensed-Black.ttf', 'BarlowCondensed', 'bold');
    _titleFontReady = true;
  } catch (e) {
    _titleFontReady = false;
  }
}

function titleFontName() { return _titleFontReady ? 'BarlowCondensed' : 'helvetica'; }

// ── PALETTE DU PDF ────────────────────────────────────────────────────────
// Palette fixe et soignée, plus chaleureuse/raffinée que le simple thème
// sombre de l'appli — la même que sur les autres pages, pour rester cohérent.
// ── PALETTE PDF DYNAMIQUE ────────────────────────────────────────────────
// Au lieu d'une palette fixe, le PDF lit les vraies couleurs du thème
// actuellement actif (variables CSS --bg, --gold, etc.) et les convertit en
// RGB utilisables par jsPDF — le PDF prend donc automatiquement l'apparence
// du thème choisi dans l'appli.

function hexToRgb(hex) {
  hex = hex.trim().replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  const num = parseInt(hex, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

// Couleur interpolée à une position donnée (0-100%) le long d'un dégradé à
// N points — utilisée aussi bien pour peindre le fond que pour faire fondre
// les bandeaux de titre exactement dans la vraie couleur locale du fond à
// cet endroit précis de la page.
function colorAtStop(stops, t) {
  let s0 = stops[0], s1 = stops[stops.length - 1];
  for (let k = 0; k < stops.length - 1; k++) {
    if (t >= stops[k].pos && t <= stops[k+1].pos) { s0 = stops[k]; s1 = stops[k+1]; break; }
  }
  const span = s1.pos - s0.pos;
  const localT = span > 0 ? Math.max(0, Math.min(1, (t - s0.pos) / span)) : 0;
  return [
    Math.round(s0.color[0] + (s1.color[0]-s0.color[0])*localT),
    Math.round(s0.color[1] + (s1.color[1]-s0.color[1])*localT),
    Math.round(s0.color[2] + (s1.color[2]-s0.color[2])*localT),
  ];
}

function lightenRgb(rgb, amt) {
  return rgb.map(c => Math.min(255, Math.round(c + (255 - c) * amt)));
}

function darkenRgb(rgb, amt) {
  return rgb.map(c => Math.max(0, Math.round(c * (1 - amt))));
}

// passe à true dès le premier lancement du chrono

function ensureTimerRunning() {
  if (!timerRunning && !matchOver) timerToggle();
}

function toggleCorrectionPanel() {
  document.getElementById('correctionPanel').classList.toggle('open');
  document.querySelector('.correction-toggle').classList.toggle('open');
}

function applyTheme(theme) { document.documentElement.setAttribute('data-theme', theme); }

function setTheme(theme) {
  if (PRO_THEMES.includes(theme) && userTier !== 'pro') {
    window.open('https://beachstats.gumroad.com/l/jlcqx', '_blank');
    return;
  }
  localStorage.setItem('beachstats_theme', theme);
  applyTheme(theme);
  document.querySelectorAll('.theme-swatch[data-theme-choice]').forEach(b => b.classList.toggle('active', b.dataset.themeChoice === theme));
  document.getElementById('themeSubmenu')?.classList.remove('open');
}

function openThemeSubmenu(e) {
  e.stopPropagation();
  document.getElementById('gearMenu')?.classList.remove('open');
  document.getElementById('themeSubmenu')?.classList.add('open');
}

function closeThemeSubmenu(e) {
  e.stopPropagation();
  document.getElementById('themeSubmenu')?.classList.remove('open');
  document.getElementById('gearMenu')?.classList.add('open');
}

function openLangSubmenu(e) {
  e.stopPropagation();
  document.getElementById('gearMenu')?.classList.remove('open');
  document.getElementById('langSubmenu')?.classList.add('open');
}

function closeLangSubmenu(e) {
  e.stopPropagation();
  document.getElementById('langSubmenu')?.classList.remove('open');
  document.getElementById('gearMenu')?.classList.add('open');
}

function closePrefsMenu(e) {
  e.stopPropagation();
  document.getElementById('prefsMenu')?.classList.remove('open');
  document.getElementById('gearMenu')?.classList.add('open');
}

function updateThemeLockUI() {
  document.querySelectorAll('.theme-swatch[data-theme-choice]').forEach(b => {
    const isProTheme = PRO_THEMES.includes(b.dataset.themeChoice);
    b.classList.toggle('locked', isProTheme && userTier !== 'pro');
  });
}

async function checkTier() {
  try {
    const res = await fetch('/api/tier');
    const data = await res.json();
    userTier = data.tier;
  } catch (e) {
    userTier = null;
  }
  updateThemeLockUI();
}
