// ── CONFIGURATION ────────────────────────────────────────────────────────
const GUMROAD_PRODUCT_ID = "Gm9Hj8rUABWevGSi6DZZ1w==";
const GUMROAD_PURCHASE_URL = "https://beachstats.gumroad.com/l/jlcqx";
const COOKIE_NAME = "beachstats_access";
const COOKIE_MAX_AGE_DAYS = 30;
const MAX_DEVICES = 3;

// ── PARTAGE EN DIRECT (spectateurs) ──────────────────────────────────────
const LIVE_CODE_RE = /^[a-zA-Z0-9]{4,12}$/;
const LIVE_TTL_SECONDS = 6 * 3600; // une entrée expire automatiquement après 6h
const LIVE_MAX_BODY_BYTES = 20000; // garde-fou anti-abus, largement suffisant pour un état de match

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

    // Partage en direct : un scoreur pousse l'état du match (POST), et
    // n'importe qui muni du lien/code peut le relire (GET) en lecture
    // seule — aucune authentification requise, le "code" fait office de
    // ticket d'accès pour cette fonctionnalité volontairement légère.
    if (url.pathname.startsWith("/api/live/")) {
      return handleLive(request, env, url);
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

async function handleLive(request, env, url) {
  const code = url.pathname.replace("/api/live/", "").split("?")[0].trim();

  if (!LIVE_CODE_RE.test(code)) {
    return jsonResponse({ error: "Code invalide." }, 400);
  }
  if (!env.MATCH_LIVE) {
    // Le binding KV n'a pas encore été créé/lié côté Cloudflare.
    return jsonResponse({ error: "Le partage en direct n'est pas encore configuré sur ce déploiement." }, 500);
  }

  const key = "live:" + code;

  if (request.method === "POST") {
    const raw = await request.text();
    if (raw.length > LIVE_MAX_BODY_BYTES) {
      return jsonResponse({ error: "Données trop volumineuses." }, 413);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return jsonResponse({ error: "JSON invalide." }, 400);
    }
    parsed.updatedAt = Date.now();
    await env.MATCH_LIVE.put(key, JSON.stringify(parsed), { expirationTtl: LIVE_TTL_SECONDS });
    return jsonResponse({ ok: true });
  }

  if (request.method === "GET") {
    const stored = await env.MATCH_LIVE.get(key);
    if (!stored) {
      return jsonResponse({ error: "Ce match n'est plus disponible (terminé depuis longtemps, ou code invalide)." }, 404);
    }
    return new Response(stored, { headers: { "Content-Type": "application/json" } });
  }

  if (request.method === "DELETE") {
    await env.MATCH_LIVE.delete(key);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: "Méthode non supportée." }, 405);
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