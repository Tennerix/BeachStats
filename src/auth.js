// ── COMPTES UTILISATEURS (email + mot de passe) ──────────────────────────
// Données stockées dans la base D1 (binding "DB") : users, sessions,
// login_tokens (liens de réinitialisation), entitlements (niveau payant),
// auth_attempts (limitation des essais).
import { WorkerMailer } from "worker-mailer";

const SESSION_COOKIE = "beachstats_session";
const SESSION_DAYS = 30;
const RESET_TTL_MS = 60 * 60 * 1000; // lien de réinitialisation valable 1 heure
const PBKDF2_ITERATIONS = 100000; // maximum accepté par les Workers
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;

const enc = new TextEncoder();

// ── Outils de chiffrement ────────────────────────────────────────────────
function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return toHex(a);
}

async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: hexToBytes(saltHex), iterations: PBKDF2_ITERATIONS },
    key,
    256
  );
  return toHex(bits);
}

// Comparaison en temps constant, pour ne rien laisser deviner par le temps de réponse.
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── Réponses ─────────────────────────────────────────────────────────────
function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extraHeaders },
  });
}

function sessionCookie(token, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

function normalizeEmail(raw) {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function validPassword(pw) {
  return typeof pw === "string" && pw.length >= MIN_PASSWORD && pw.length <= MAX_PASSWORD;
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "inconnue";
}

// ── Limitation des essais (anti devinette de mot de passe) ───────────────
async function countAttempts(env, key, windowMs) {
  const row = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM auth_attempts WHERE key = ?1 AND at > ?2")
    .bind(key, Date.now() - windowMs)
    .first();
  return row ? row.n : 0;
}

async function recordAttempt(env, key) {
  await env.DB.prepare("INSERT INTO auth_attempts (key, at) VALUES (?1, ?2)").bind(key, Date.now()).run();
}

async function purgeOldAttempts(env) {
  await env.DB.prepare("DELETE FROM auth_attempts WHERE at < ?1").bind(Date.now() - 86400000).run();
}

// ── Sessions ─────────────────────────────────────────────────────────────
async function startSession(env, userId) {
  const token = randomHex(32);
  const now = Date.now();
  await env.DB
    .prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(await sha256Hex(token), userId, now, now + SESSION_DAYS * 86400000)
    .run();
  return sessionCookie(token, SESSION_DAYS * 86400);
}

function readSessionToken(request) {
  const match = (request.headers.get("Cookie") || "").match(new RegExp(SESSION_COOKIE + "=([a-f0-9]{64})"));
  return match ? match[1] : null;
}

// Renvoie { id, email } si le visiteur est connecté, sinon null.
export async function getAccount(request, env) {
  if (!env.DB) return null;
  const token = readSessionToken(request);
  if (!token) return null;
  const row = await env.DB
    .prepare(
      "SELECT u.id AS id, u.email AS email FROM sessions s JOIN users u ON u.id = s.user_id " +
      "WHERE s.token_hash = ?1 AND s.expires_at > ?2"
    )
    .bind(await sha256Hex(token), Date.now())
    .first();
  return row || null;
}

// Niveau payant rattaché au compte : 'pro', 'avancees' ou null.
export async function getAccountTier(env, userId) {
  const { results } = await env.DB
    .prepare("SELECT tier FROM entitlements WHERE user_id = ?1 AND revoked_at IS NULL")
    .bind(userId)
    .all();
  const tiers = (results || []).map(r => r.tier);
  if (tiers.includes("pro")) return "pro";
  if (tiers.includes("avancees")) return "avancees";
  return null;
}

// ── Envoi d'email (SMTP Gmail, mot de passe d'application) ───────────────
async function sendMail(env, to, subject, text) {
  if (env.MAIL_DEBUG === "1") {
    console.log("[MAIL_DEBUG]", to, subject, text);
    return;
  }
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    console.error("Envoi d'email impossible : GMAIL_USER ou GMAIL_APP_PASSWORD manquant.");
    return;
  }
  const mailer = await WorkerMailer.connect({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    credentials: {
      username: env.GMAIL_USER,
      // Google affiche le code par blocs de 4 lettres séparés par des espaces.
      password: env.GMAIL_APP_PASSWORD.replace(/\s+/g, ""),
    },
    authType: "plain",
  });
  try {
    await mailer.send({
      from: { name: "BeachStats", email: env.GMAIL_USER },
      to: { email: to },
      subject,
      text,
    });
  } finally {
    await mailer.close();
  }
}

// ── Routes /api/auth/* ───────────────────────────────────────────────────
export async function handleAuth(request, env, ctx, url) {
  if (!env.DB) return json({ error: "Les comptes ne sont pas encore configurés sur ce déploiement." }, 500);

  const path = url.pathname;

  if (path === "/api/auth/me" && request.method === "GET") {
    const account = await getAccount(request, env);
    if (!account) return json({ email: null, tier: null });
    return json({ email: account.email, tier: await getAccountTier(env, account.id) });
  }

  if (request.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);

  // Protection contre les envois depuis un autre site : le navigateur indique
  // toujours d'où vient une requête POST, on refuse tout ce qui n'est pas nous.
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return json({ error: "Requête refusée." }, 403);
  if (!(request.headers.get("Content-Type") || "").includes("application/json")) {
    return json({ error: "Requête invalide." }, 400);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Requête invalide." }, 400);
  }
  if (!body || typeof body !== "object") return json({ error: "Requête invalide." }, 400);

  const ip = clientIp(request);

  // ── Inscription ──
  if (path === "/api/auth/register") {
    const email = normalizeEmail(body.email);
    if (!email) return json({ error: "Adresse email invalide." }, 400);
    if (!validPassword(body.password)) {
      return json({ error: `Le mot de passe doit faire au moins ${MIN_PASSWORD} caractères.` }, 400);
    }
    if ((await countAttempts(env, "register:" + ip, 3600000)) >= 10) {
      return json({ error: "Trop de tentatives. Réessaie dans une heure." }, 429);
    }
    await recordAttempt(env, "register:" + ip);
    ctx.waitUntil(purgeOldAttempts(env));

    const salt = randomHex(16);
    const hash = await hashPassword(body.password, salt);
    const userId = crypto.randomUUID();
    try {
      await env.DB
        .prepare("INSERT INTO users (id, email, created_at, password_hash, password_salt) VALUES (?1, ?2, ?3, ?4, ?5)")
        .bind(userId, email, Date.now(), hash, salt)
        .run();
    } catch (e) {
      if (String(e && e.message).includes("UNIQUE")) {
        return json({ error: "Un compte existe déjà avec cet email." }, 409);
      }
      throw e;
    }
    const cookie = await startSession(env, userId);
    return json({ ok: true, email }, 200, { "Set-Cookie": cookie });
  }

  // ── Connexion ──
  if (path === "/api/auth/login") {
    const email = normalizeEmail(body.email);
    const password = typeof body.password === "string" ? body.password.slice(0, MAX_PASSWORD) : "";
    const emailKey = "login:" + (email || "?");
    const ipKey = "login-ip:" + ip;
    if ((await countAttempts(env, emailKey, 900000)) >= 8 || (await countAttempts(env, ipKey, 900000)) >= 30) {
      return json({ error: "Trop d'essais. Réessaie dans 15 minutes." }, 429);
    }

    const user = email
      ? await env.DB.prepare("SELECT id, password_hash, password_salt FROM users WHERE email = ?1").bind(email).first()
      : null;

    // Même travail de calcul que le compte existe ou non, pour ne pas
    // révéler par le temps de réponse quels emails sont inscrits.
    const salt = user && user.password_salt ? user.password_salt : "00".repeat(16);
    const computed = await hashPassword(password, salt);
    const ok = !!(user && user.password_hash && safeEqual(computed, user.password_hash));

    if (!ok) {
      await recordAttempt(env, emailKey);
      await recordAttempt(env, ipKey);
      return json({ error: "Email ou mot de passe incorrect." }, 401);
    }
    const cookie = await startSession(env, user.id);
    return json({ ok: true, email }, 200, { "Set-Cookie": cookie });
  }

  // ── Déconnexion ──
  if (path === "/api/auth/logout") {
    const token = readSessionToken(request);
    if (token) {
      await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?1").bind(await sha256Hex(token)).run();
    }
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
  }

  // ── Mot de passe oublié : on répond toujours pareil, que le compte existe ou non ──
  if (path === "/api/auth/forgot") {
    const email = normalizeEmail(body.email);
    const generic = json({ ok: true });
    if (!email) return generic;

    const emailKey = "forgot:" + email;
    const ipKey = "forgot-ip:" + ip;
    const tooMany =
      (await countAttempts(env, emailKey, 3600000)) >= 3 || (await countAttempts(env, ipKey, 3600000)) >= 10;
    await recordAttempt(env, emailKey);
    await recordAttempt(env, ipKey);
    if (tooMany) return generic;

    const user = await env.DB.prepare("SELECT id FROM users WHERE email = ?1").bind(email).first();
    if (!user) return generic;

    const token = randomHex(32);
    await env.DB.prepare("DELETE FROM login_tokens WHERE email = ?1 AND purpose = 'reset'").bind(email).run();
    await env.DB
      .prepare("INSERT INTO login_tokens (token_hash, email, expires_at, purpose) VALUES (?1, ?2, ?3, 'reset')")
      .bind(await sha256Hex(token), email, Date.now() + RESET_TTL_MS)
      .run();

    const link = `${url.origin}/compte?reset=${token}`;
    const text =
      "Bonjour,\n\n" +
      "Tu as demandé à changer ton mot de passe BeachStats. Clique sur ce lien pour en choisir un nouveau " +
      "(il est valable 1 heure) :\n\n" +
      link + "\n\n" +
      "Si tu n'es pas à l'origine de cette demande, ignore simplement ce message : ton mot de passe actuel reste valable.\n\n" +
      "BeachStats";
    ctx.waitUntil(
      sendMail(env, email, "BeachStats – nouveau mot de passe", text).catch(e =>
        console.error("Échec de l'envoi de l'email de réinitialisation :", e && e.message)
      )
    );
    return generic;
  }

  // ── Choix du nouveau mot de passe, depuis le lien reçu par email ──
  if (path === "/api/auth/reset") {
    if (typeof body.token !== "string" || !/^[a-f0-9]{64}$/.test(body.token)) {
      return json({ error: "Lien invalide ou expiré." }, 400);
    }
    if (!validPassword(body.password)) {
      return json({ error: `Le mot de passe doit faire au moins ${MIN_PASSWORD} caractères.` }, 400);
    }
    const tokenHash = await sha256Hex(body.token);
    const row = await env.DB
      .prepare(
        "SELECT email FROM login_tokens WHERE token_hash = ?1 AND purpose = 'reset' " +
        "AND used_at IS NULL AND expires_at > ?2"
      )
      .bind(tokenHash, Date.now())
      .first();
    if (!row) return json({ error: "Lien invalide ou expiré." }, 400);

    const user = await env.DB.prepare("SELECT id FROM users WHERE email = ?1").bind(row.email).first();
    if (!user) return json({ error: "Lien invalide ou expiré." }, 400);

    const salt = randomHex(16);
    const hash = await hashPassword(body.password, salt);
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET password_hash = ?1, password_salt = ?2 WHERE id = ?3").bind(hash, salt, user.id),
      env.DB.prepare("UPDATE login_tokens SET used_at = ?1 WHERE token_hash = ?2").bind(Date.now(), tokenHash),
      // Toutes les sessions ouvertes sont fermées : si quelqu'un d'autre avait accès au compte, il est déconnecté.
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(user.id),
    ]);
    return json({ ok: true });
  }

  return json({ error: "Route inconnue." }, 404);
}
