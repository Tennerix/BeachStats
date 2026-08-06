// ── CONFIGURATION ────────────────────────────────────────────────────────
const GUMROAD_PRODUCT_ID = "Gm9Hj8rUABWevGSi6DZZ1w==";
const GUMROAD_PURCHASE_URL = "https://beachstats.gumroad.com/l/jlcqx";
const COOKIE_NAME = "beachstats_access";
const COOKIE_MAX_AGE_DAYS = 30;
const MAX_DEVICES = 3;

const ROUTES = {
  "/avancees": { file: "/avancees.html", requiredTier: "avancees" },
  "/pro": { file: "/pro.html", requiredTier: "pro" },
  "/historique": { file: "/historique.html", requiredTier: "avancees" },
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/verify" && request.method === "POST") {
      return handleVerify(request, env, url);
    }

    const route = ROUTES[url.pathname];
    if (route) {
      const session = await readSessionCookie(request, env);
      const hasAccess =
        session &&
        (session.tier === "pro" || session.tier === route.requiredTier);

      if (hasAccess) {
        const assetUrl = new URL(route.file, request.url);
        return env.ASSETS.fetch(new Request(assetUrl, request));
      }
      return renderLoginPage(url.pathname + url.search);
    }

    return new Response("Page introuvable", { status: 404 });
  },
};

async function handleVerify(request, env, url) {
  const form = await request.formData();
  const licenseKey = (form.get("license_key") || "").trim();
  const dest = form.get("dest") || "/avancees";

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
    <input type="hidden" name="dest" value="${dest}">
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
