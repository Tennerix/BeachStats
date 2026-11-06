import { getAccount } from "./auth.js";

// Adresse(s) autorisée(s) à ouvrir la page d'administration.
// Par défaut : l'adresse du propriétaire. Pour la changer sans toucher au code,
// définir la variable ADMIN_EMAIL dans Cloudflare (plusieurs adresses : séparées par des virgules).
const DEFAULT_ADMIN = "supportsbeachstats@gmail.com";

function adminList(env) {
  const raw = (env && env.ADMIN_EMAIL ? String(env.ADMIN_EMAIL) : DEFAULT_ADMIN);
  return raw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

// Renvoie le compte si c'est un administrateur (adresse autorisée ET confirmée), sinon null.
export async function getAdmin(request, env) {
  try {
    const account = await getAccount(request, env);
    if (!account || !account.verified_at) return null;
    return adminList(env).includes(String(account.email).toLowerCase()) ? account : null;
  } catch (e) {
    return null;
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
}

// GET /api/admin/stats : chiffres globaux + liste des comptes.
// Ne renvoie jamais de mot de passe, de code de licence ni de jeton.
export async function handleAdmin(request, env, url) {
  if (!env.DB) return json({ error: "Base non configurée." }, 500);
  // Toute personne non autorisée reçoit un 404, comme si la route n'existait pas.
  const admin = await getAdmin(request, env);
  if (!admin) return json({ error: "Introuvable." }, 404);
  const path = url.pathname;

  // ── Actions : suspendre / réactiver / supprimer un compte ──
  if (path === "/api/admin/ban" || path === "/api/admin/delete") {
    if (request.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return json({ error: "Requête refusée." }, 403);
    if (!(request.headers.get("Content-Type") || "").includes("application/json")) return json({ error: "Requête invalide." }, 400);
    let body;
    try { body = await request.json(); } catch { return json({ error: "Requête invalide." }, 400); }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email) return json({ error: "Adresse manquante." }, 400);
    // On ne touche jamais à un compte administrateur.
    if (adminList(env).includes(email)) return json({ error: "Impossible sur un compte administrateur." }, 400);
    const user = await env.DB.prepare("SELECT id FROM users WHERE email = ?1").bind(email).first();
    if (!user) return json({ error: "Compte introuvable." }, 404);

    if (path === "/api/admin/ban") {
      const ban = body.banned !== false;
      if (ban) {
        await env.DB.batch([
          env.DB.prepare("UPDATE users SET banned_at = ?1 WHERE id = ?2").bind(Date.now(), user.id),
          env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(user.id),
        ]);
      } else {
        await env.DB.prepare("UPDATE users SET banned_at = NULL WHERE id = ?1").bind(user.id).run();
      }
      return json({ ok: true, banned: ban });
    }

    // Suppression définitive : compte, accès, matchs et connexions. Le code d'accès
    // utilisé redevient libre (pour un abus, préfère « Suspendre »).
    await env.DB.batch([
      env.DB.prepare("DELETE FROM matches WHERE user_id = ?1").bind(user.id),
      env.DB.prepare("DELETE FROM entitlements WHERE user_id = ?1").bind(user.id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(user.id),
      env.DB.prepare("DELETE FROM login_tokens WHERE email = ?1").bind(email),
      env.DB.prepare("DELETE FROM users WHERE id = ?1").bind(user.id),
    ]);
    return json({ ok: true, deleted: true });
  }

  if (path !== "/api/admin/stats" || request.method !== "GET") return json({ error: "Introuvable." }, 404);

  const now = Date.now();
  const week = now - 7 * 86400000;

  const totals = await env.DB
    .prepare(
      "SELECT " +
      "(SELECT COUNT(*) FROM users) AS users, " +
      "(SELECT COUNT(*) FROM users WHERE email_verified_at IS NOT NULL) AS verified, " +
      "(SELECT COUNT(*) FROM users WHERE created_at > ?1) AS new7, " +
      "(SELECT COUNT(DISTINCT user_id) FROM entitlements WHERE revoked_at IS NULL AND tier = 'pro') AS pro, " +
      "(SELECT COUNT(DISTINCT user_id) FROM entitlements WHERE revoked_at IS NULL AND tier = 'avancees') AS avancees, " +
      "(SELECT COUNT(*) FROM users WHERE banned_at IS NOT NULL) AS banned, " +
      "(SELECT COUNT(*) FROM sessions WHERE expires_at > ?2) AS sessions, " +
      "(SELECT COUNT(*) FROM matches) AS matches"
    )
    .bind(week, now)
    .first();

  const { results } = await env.DB
    .prepare(
      "SELECT u.email AS email, u.created_at AS created_at, u.email_verified_at AS verified_at, u.banned_at AS banned_at, " +
      "(SELECT group_concat(tier) FROM entitlements e WHERE e.user_id = u.id AND e.revoked_at IS NULL) AS tiers, " +
      "(SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?1) AS devices, " +
      "(SELECT COUNT(*) FROM matches m WHERE m.user_id = u.id) AS matches " +
      "FROM users u ORDER BY u.created_at DESC LIMIT 500"
    )
    .bind(now)
    .all();

  const users = (results || []).map(r => ({
    email: r.email,
    createdAt: r.created_at,
    verified: !!r.verified_at,
    banned: !!r.banned_at,
    isAdmin: adminList(env).includes(String(r.email).toLowerCase()),
    tier: r.tiers && r.tiers.includes("pro") ? "pro" : r.tiers ? "avancees" : null,
    devices: r.devices,
    matches: r.matches,
  }));

  return json({ totals, users, shown: users.length });
}
