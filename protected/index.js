// ── CONFIGURATION ────────────────────────────────────────────────────────
const GUMROAD_PRODUCT_ID = "Gm9Hj8rUABWevGSi6DZZ1w==";
const GUMROAD_PURCHASE_URL = "https://beachstats.gumroad.com/l/jlcqx";
const COOKIE_NAME = "beachstats_access";
const COOKIE_MAX_AGE_DAYS = 30;
const MAX_DEVICES = 3;

// ── PARTAGE EN DIRECT (spectateurs) ──────────────────────────────────────
// Repose sur un Durable Object (un par code de match) qui garde l'état en
// mémoire/stockage et relaie chaque mise à jour à tous les WebSockets
// connectés (scoreur + spectateurs). Remplace l'ancien système à base de KV
// (limité à 1000 écritures/jour au total, tous utilisateurs confondus) —
// avec les WebSockets, les messages entrants coûtent une fraction de
// requête (quota bien plus généreux) et la diffusion vers les spectateurs
// ne coûte rien du tout, quel que soit leur nombre.
const LIVE_CODE_RE = /^[a-zA-Z0-9]{4,12}$/;
const LIVE_TTL_MS = 6 * 3600 * 1000; // un match sans mise à jour depuis 6h est effacé
const LIVE_MAX_MESSAGE_BYTES = 20000; // garde-fou anti-abus, largement suffisant pour un état de match

// tier: null = accès libre, aucune vérification. Sinon 'avancees' ou 'pro'.
const ROUTES = {
  "/":              { file: "/index.html",         tier: null },
  "/points":        { file: "/points.html",         tier: null },
  "/base":          { file: "/base.html",           tier: null },
  "/intermediaire": { file: "/intermediaire.html",  tier: null },
  "/historique":    { file: "/historique.html",     tier: null },
  "/live":          { file: "/live.html",           tier: null },
  "/avancees":      { file: "/avancees.html",       tier: "avancees" },
  "/pro":           { file: "/pro.html",            tier: "pro" },
};

// Le paramètre "dest" (page vers laquelle rediriger après connexion) vient
// d'un formulaire, donc potentiellement manipulable. On ne fait jamais
// confiance à sa valeur telle quelle : on vérifie qu'il s'agit bien d'un
// chemin relatif (jamais une adresse externe) correspondant à une de nos
// vraies pages, sinon on retombe sur une valeur sûre par défaut. Ça évite
// à la fois une redirection piégée vers un site extérieur (open redirect)
// et une injection de code dans la page de connexion.
function sanitizeDest(dest) {
  if (typeof dest !== "string" || !dest) return "/avancees";
  if (!dest.startsWith("/") || dest.startsWith("//") || dest.includes("\\")) return "/avancees";
  const path = dest.split("?")[0];
  if (!(path in ROUTES)) return "/avancees";
  return dest;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/verify" && request.method === "POST") {
      return handleVerify(request, env, url);
    }

    // Petit endpoint utilisé par le sélecteur de thème : indique au
    // JavaScript de la page (sans jamais exposer le cookie lui-même,
    // qui reste HttpOnly) si le visiteur a un accès Avancées/Pro valide,
    // peu importe la page où il se trouve.
    if (url.pathname === "/api/tier") {
      const session = await readSessionCookie(request, env);
      return jsonResponse({ tier: session ? session.tier : null });
    }

    // Partage en direct : un scoreur et n'importe quel nombre de spectateurs
    // se connectent tous au même Durable Object (identifié par le code du
    // match) via WebSocket — aucune authentification requise, le "code"
    // fait office de ticket d'accès pour cette fonctionnalité volontairement
    // légère, exactement comme avant.
    if (url.pathname.startsWith("/api/live/")) {
      const code = url.pathname.replace("/api/live/", "").split("?")[0].trim();
      if (!LIVE_CODE_RE.test(code)) {
        return jsonResponse({ error: "Code invalide." }, 400);
      }
      if (!env.LIVE_MATCH) {
        // Le binding Durable Object n'a pas encore été créé/lié côté Cloudflare.
        return jsonResponse({ error: "Le partage en direct n'est pas encore configuré sur ce déploiement." }, 500);
      }
      const id = env.LIVE_MATCH.idFromName(code);
      const stub = env.LIVE_MATCH.get(id);
      return stub.fetch(request);
    }

    const route = ROUTES[url.pathname];
    if (route) {
      if (route.tier === null) {
        const assetUrl = new URL(route.file, request.url);
        return env.ASSETS.fetch(new Request(assetUrl, request));
      }

      const session = await readSessionCookie(request, env);
      const hasAccess =
        session && (session.tier === "pro" || session.tier === route.tier);

      if (hasAccess) {
        const assetUrl = new URL(route.file, request.url);
        return env.ASSETS.fetch(new Request(assetUrl, request));
      }
      return renderLoginPage(sanitizeDest(url.pathname + url.search));
    }

    // Pas une route connue : on tente quand même de servir un asset statique
    // tel quel (ex: image1.png, favicon...), sinon 404.
    try {
      return await env.ASSETS.fetch(request);
    } catch {
      return new Response("Page introuvable", { status: 404 });
    }
  },
};

// ── Durable Object : un par code de match, tant qu'il reste actif ─────────
// Garde le dernier état connu en stockage persistant (survit à une mise en
// hibernation de l'objet entre deux messages) et relaie chaque mise à jour
// à tous les clients connectés — le scoreur ET les spectateurs, qui parlent
// tous le même petit protocole WebSocket texte (un message = un état complet
// du match, en JSON).
export class LiveMatch {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Cette route n'accepte que les connexions WebSocket.", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // L'API d'hibernation permet à Cloudflare de libérer la mémoire/CPU de
    // cet objet entre deux messages tout en gardant la connexion ouverte —
    // bien plus économe qu'un objet actif en continu pour une connexion qui
    // ne parle, en pratique, que quelques fois par minute.
    this.ctx.acceptWebSocket(server);

    // Un spectateur qui vient de se connecter (ou le scoreur après une
    // reconnexion) doit voir l'état actuel tout de suite, sans attendre la
    // prochaine action — on le lui envoie dès que la connexion est prête.
    const stored = await this.ctx.storage.get("state");
    if (stored) {
      try { server.send(stored); } catch (e) { /* connexion déjà refermée */ }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > LIVE_MAX_MESSAGE_BYTES) return;

    let parsed;
    try {
      parsed = JSON.parse(message);
    } catch {
      return; // message invalide, on ignore silencieusement
    }
    parsed.updatedAt = Date.now();
    const toStore = JSON.stringify(parsed);

    await this.ctx.storage.put("state", toStore);
    // Ré-arme l'expiration automatique à chaque mise à jour, comme le
    // faisait le TTL de l'ancien système KV.
    await this.ctx.storage.setAlarm(Date.now() + LIVE_TTL_MS);

    // Diffuse à tous les clients connectés à ce match (spectateurs et
    // l'onglet du scoreur lui-même — sans effet néfaste, il a déjà cet état
    // en local).
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.send(toStore); } catch (e) { /* connexion fermée entre-temps */ }
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    try { ws.close(code, reason); } catch (e) {}
  }

  async webSocketError(ws) {}

  // Personne n'a mis à jour ce match depuis 6h (LIVE_TTL_MS) : on efface son
  // état pour ne pas accumuler indéfiniment du stockage inutile.
  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}

async function handleVerify(request, env, url) {
  const form = await request.formData();
  const licenseKey = (form.get("license_key") || "").trim();
  const dest = sanitizeDest(form.get("dest"));

  if (!licenseKey) {
    return renderLoginPage(dest, "Merci d'entrer un code.");
  }

  const body = new URLSearchParams();
  body.append("product_id", GUMROAD_PRODUCT_ID);
  body.append("license_key", licenseKey);
  body.append("increment_uses_count", "true");

  const gumroadRes = await fetch("https://api.gumroad.com/v2/licenses/verify", {
    method: "POST",
    body,
  });
  const data = await gumroadRes.json();

  const purchase = data.purchase;
  const isActive =
    data.success &&
    purchase &&
    !purchase.refunded &&
    !purchase.chargebacked &&
    !purchase.subscription_cancelled_at &&
    !purchase.subscription_failed_at;

  if (!isActive) {
    return renderLoginPage(dest, "Code invalide ou abonnement inactif.");
  }

  if (data.uses > MAX_DEVICES) {
    return renderLoginPage(dest, "Ce code a déjà été utilisé sur trop d'appareils.");
  }

  const variantText = (purchase.variants || "").toLowerCase();
  const tier = variantText.includes("pro") ? "pro" : "avancees";

  const cookie = await createSessionCookie(tier, env);
  return new Response(null, {
    status: 302,
    headers: {
      "Set-Cookie": cookie,
      Location: dest,
    },
  });
}

async function createSessionCookie(tier, env) {
  const payload = JSON.stringify({
    tier,
    exp: Date.now() + COOKIE_MAX_AGE_DAYS * 86400000,
  });
  const signature = await sign(payload, env.COOKIE_SECRET);
  const value = btoa(payload) + "." + signature;
  return `${COOKIE_NAME}=${value}; Path=/; Max-Age=${COOKIE_MAX_AGE_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
}

async function readSessionCookie(request, env) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(new RegExp(COOKIE_NAME + "=([^;]+)"));
  if (!match) return null;

  const [encodedPayload, signature] = match[1].split(".");
  if (!encodedPayload || !signature) return null;

  const payload = atob(encodedPayload);
  const expectedSig = await sign(payload, env.COOKIE_SECRET);
  if (expectedSig !== signature) return null;

  const session = JSON.parse(payload);
  if (Date.now() > session.exp) return null;

  return session;
}

async function sign(text, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(sigBuffer)));
}

function renderLoginPage(dest, error) {
  const html = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Accès BeachStats</title>
<style>
body{font-family:sans-serif;background:#0a1628;color:#e0eaf8;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{background:#111e35;border:1px solid #1e3560;border-radius:16px;padding:2rem;max-width:360px;width:90%}
h1{font-size:18px;margin:0 0 1rem}
input{width:100%;padding:10px;border-radius:8px;border:1px solid #1e3560;background:#0d1a2e;color:#fff;margin-bottom:1rem;box-sizing:border-box}
button{width:100%;padding:10px;border-radius:8px;border:none;background:#f5c518;font-weight:bold;cursor:pointer}
.err{color:#f97316;font-size:13px;margin-bottom:1rem}
.info{text-align:center;font-size:11px;color:#5a7299;margin-top:1rem;line-height:1.5}
.buy{text-align:center;margin-top:.75rem;font-size:13px;color:#8ba3c7}
.buy a{color:#f5c518;text-decoration:none;font-weight:bold}
</style></head>
<body>
<div class="box">
  <h1>Entre ton code d'accès</h1>
  ${error ? `<div class="err">${error}</div>` : ""}
  <form method="POST" action="/verify">
    <input type="hidden" name="dest" value="${escapeHtml(dest)}">
    <input type="text" name="license_key" placeholder="XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX" required>
    <button type="submit">Débloquer l'accès</button>
  </form>
  <p class="info">
    Un code débloque l'accès sur 3 appareils maximum.<br>
    L'accès est automatiquement suspendu si l'abonnement n'est pas renouvelé.
  </p>
  <p class="buy">Pas encore de code ? <a href="${GUMROAD_PURCHASE_URL}" target="_blank">Débloquer l'accès ici →</a></p>
</div>
</body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
}
