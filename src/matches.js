import { getAccount, getAccountTier } from "./auth.js";

// Nombre de matchs stockables dans le cloud selon le niveau du compte.
// Le Pro est "illimité" pour l'utilisateur ; le plafond technique n'est là
// que pour éviter qu'un compte ne remplisse la base par erreur ou abus.
const LIMITS = { free: 4, avancees: 10, pro: 500 };
const MAX_MATCH_BYTES = 600 * 1024; // taille maximale d'un match
const MAX_BATCH = 100; // matchs envoyés en une seule requête

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function limitFor(tier) {
  return LIMITS[tier] ?? LIMITS.free;
}

// POST /api/matches/sync
// Corps : { known: [ids présents sur l'appareil], upsert: [matchs à envoyer], remove: [ids à supprimer] }
// Réponse : { tier, limit, unlimited, count, ids: [tous les ids du cloud],
//             matches: [matchs du cloud que l'appareil n'a pas], rejected: [ids refusés] }
export async function handleMatches(request, env, url) {
  if (!env.DB) return json({ error: "Base non configurée." }, 500);
  if (url.pathname !== "/api/matches/sync") return json({ error: "Route inconnue." }, 404);
  if (request.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);

  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return json({ error: "Requête refusée." }, 403);
  if (!(request.headers.get("Content-Type") || "").includes("application/json")) {
    return json({ error: "Requête invalide." }, 400);
  }

  const account = await getAccount(request, env);
  if (!account) return json({ error: "Non connecté." }, 401);
  if (!account.verified_at) return json({ error: "Adresse email non confirmée.", unverified: true }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Requête invalide." }, 400);
  }
  const known = new Set((Array.isArray(body.known) ? body.known : []).map(String));
  const remove = (Array.isArray(body.remove) ? body.remove : []).slice(0, 500).map(String);
  const upsert = (Array.isArray(body.upsert) ? body.upsert : []).slice(0, MAX_BATCH);

  const tier = await getAccountTier(env, account.id);
  const limit = limitFor(tier);
  const now = Date.now();

  // 1. Suppressions demandées par l'appareil
  for (const id of remove) {
    await env.DB.prepare("DELETE FROM matches WHERE user_id = ?1 AND id = ?2").bind(account.id, account.id + ":" + id).run();
  }

  // 2. Nouveaux matchs, dans la limite du niveau (les plus anciens d'abord)
  const rejected = [];
  const countRow = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM matches WHERE user_id = ?1")
    .bind(account.id)
    .first();
  let count = countRow ? countRow.n : 0;

  upsert.sort((a, b) => Number(a && a.id) - Number(b && b.id));
  for (const m of upsert) {
    if (!m || typeof m !== "object" || m.id == null) continue;
    const id = String(m.id);
    const data = JSON.stringify(m);
    if (data.length > MAX_MATCH_BYTES) {
      rejected.push(id);
      continue;
    }
    const exists = await env.DB
      .prepare("SELECT 1 AS x FROM matches WHERE user_id = ?1 AND id = ?2")
      .bind(account.id, account.id + ":" + id)
      .first();
    if (exists) continue;
    if (count >= limit) {
      rejected.push(id);
      continue;
    }
    // L'identifiant d'un match (une date) n'est unique que par utilisateur : on le
    // préfixe dans la clé primaire pour que deux comptes ne puissent pas se gêner.
    await env.DB
      .prepare(
        "INSERT OR IGNORE INTO matches (id, user_id, played_at, mode, data, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)"
      )
      .bind(account.id + ":" + id, account.id, Number(m.id) || now, String(m.mode || ""), data, now)
      .run();
    count++;
  }

  // 3. État du cloud : tous les ids, et les matchs que l'appareil ne connaît pas
  const { results } = await env.DB
    .prepare("SELECT id, data FROM matches WHERE user_id = ?1 ORDER BY played_at DESC")
    .bind(account.id)
    .all();
  const prefix = account.id + ":";
  const ids = [];
  const matches = [];
  for (const row of results || []) {
    const id = row.id.startsWith(prefix) ? row.id.slice(prefix.length) : row.id;
    ids.push(id);
    if (!known.has(id)) {
      try {
        matches.push(JSON.parse(row.data));
      } catch {
        /* match illisible : ignoré */
      }
    }
  }

  return json({
    tier: tier || "free",
    limit: tier === "pro" ? null : limit,
    count: ids.length,
    ids,
    matches,
    rejected,
  });
}
