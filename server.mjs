import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { closePool, getPool, pool } from "./database.mjs";
import {
    DataSalesError,
    listMtnDataPlans,
    listRecentDataOrders,
    purchaseMtnBundle,
} from "./data-sales.mjs";
const scrypt = promisify(scryptCallback);
const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";
const COOKIE_NAME = "sarki_session";
const PASSWORD_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const PASSWORD_HASH_BYTES = 64;
const DUMMY_PASSWORD_SALT = Buffer.alloc(16, 0x73);
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_PER_IP = 30;
const RATE_LIMIT_PER_PHONE = 8;
const RATE_LIMIT_DATA_PURCHASES_PER_ACCOUNT = 8;
const MAX_REQUEST_BYTES = 16 * 1024;
const appDirectory = dirname(fileURLToPath(import.meta.url));
const landingPagePath = resolve(appDirectory, "index.html");
const authRateLimits = new Map();

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error("PORT must be a valid TCP port.");
}

class HttpError extends Error {
    constructor(status, message, retryAfterSeconds) {
        super(message);
        this.status = status;
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

function sendJson(response, status, payload, headers = {}) {
    response.writeHead(status, {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        ...headers,
    });
    response.end(JSON.stringify(payload));
}

function getFirstHeaderValue(value) {
    if (Array.isArray(value)) return value[0]?.split(",")[0].trim();
    return typeof value === "string" ? value.split(",")[0].trim() : "";
}

function requestHost(request) {
    return getFirstHeaderValue(request.headers["x-forwarded-host"])
        || getFirstHeaderValue(request.headers.host);
}

function isSameOriginRequest(request) {
    const origin = request.headers.origin;
    const forwardedHost = requestHost(request);
    if (typeof origin !== "string" || !forwardedHost) return false;

    try {
        const originUrl = new URL(origin);
        if (originUrl.protocol !== "https:" && originUrl.protocol !== "http:") return false;
        const expectedUrl = new URL(`${originUrl.protocol}//${forwardedHost}`);
        return originUrl.origin === expectedUrl.origin;
    } catch {
        return false;
    }
}

function secureCookie(request) {
    const forwardedProtocol = getFirstHeaderValue(request.headers["x-forwarded-proto"]).toLowerCase();
    return forwardedProtocol === "https" || Boolean(request.socket.encrypted);
}

function setSessionCookie(request, response, token) {
    const secure = secureCookie(request) ? "; Secure" : "";
    response.setHeader(
        "Set-Cookie",
        `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax${secure}`,
    );
}

function readSessionToken(request) {
    const cookieHeader = request.headers.cookie;
    if (typeof cookieHeader !== "string") return null;
    const cookie = cookieHeader
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${COOKIE_NAME}=`));
    if (!cookie) return null;

    const token = cookie.slice(COOKIE_NAME.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

function hashSessionToken(token) {
    return createHash("sha256").update(token).digest("hex");
}

function normalizePhone(value) {
    if (typeof value !== "string") {
        throw new HttpError(400, "Enter a valid phone number.");
    }

    const compact = value.trim().replace(/[\s().-]/g, "");
    if (!/^\+?\d+$/.test(compact)) {
        throw new HttpError(400, "Enter a valid Nigerian mobile number or an international number beginning with +.");
    }

    if (/^0[789]\d{9}$/.test(compact)) return `+234${compact.slice(1)}`;
    if (/^234[789]\d{9}$/.test(compact)) return `+${compact}`;
    if (/^\+[1-9]\d{7,14}$/.test(compact)) return compact;

    throw new HttpError(400, "Enter a valid Nigerian mobile number or an international number beginning with +.");
}

function validatePassword(value) {
    if (typeof value !== "string" || value.length === 0 || value.length > 128) {
        throw new HttpError(400, "Enter a password of 1 to 128 characters.");
    }
    if (value.length < 5) {
        throw new HttpError(400, "Use a password with at least 5 characters.");
    }
    return value;
}

async function derivePasswordHash(password, salt) {
    return Buffer.from(await scrypt(password, salt, PASSWORD_HASH_BYTES, PASSWORD_OPTIONS));
}

function getClientAddress(request) {
    return getFirstHeaderValue(request.headers["x-forwarded-for"])
        || getFirstHeaderValue(request.headers["x-real-ip"])
        || request.socket.remoteAddress
        || "unknown";
}

function consumeRateLimit(key, limit) {
    const now = Date.now();
    const current = authRateLimits.get(key);
    if (!current || now - current.startedAt >= RATE_LIMIT_WINDOW_MS) {
        authRateLimits.set(key, { startedAt: now, count: 1 });
        return;
    }
    if (current.count >= limit) {
        const retryAfterSeconds = Math.max(
            1,
            Math.ceil((RATE_LIMIT_WINDOW_MS - (now - current.startedAt)) / 1000),
        );
        throw new HttpError(429, "Too many attempts. Wait a little and try again.", retryAfterSeconds);
    }
    current.count += 1;
}

function enforceIpRateLimit(request) {
    consumeRateLimit(`ip:${getClientAddress(request)}`, RATE_LIMIT_PER_IP);
    if (authRateLimits.size > 5000) {
        const now = Date.now();
        for (const [key, value] of authRateLimits) {
            if (now - value.startedAt >= RATE_LIMIT_WINDOW_MS) authRateLimits.delete(key);
        }
    }
}

function enforcePhoneRateLimit(phone) {
    consumeRateLimit(`phone:${phone}`, RATE_LIMIT_PER_PHONE);
}

async function readJsonBody(request) {
    if (!request.headers["content-type"]?.toLowerCase().includes("application/json")) {
        throw new HttpError(415, "Send the request as JSON.");
    }

    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_REQUEST_BYTES) {
            throw new HttpError(413, "The request is too large.");
        }
        chunks.push(chunk);
    }

    try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("Expected an object.");
        }
        return parsed;
    } catch {
        throw new HttpError(400, "The request body is not valid JSON.");
    }
}

function requireSameOrigin(request) {
    if (!isSameOriginRequest(request)) {
        throw new HttpError(403, "This request could not be verified. Refresh the page and try again.");
    }
}

function issueSessionCookie(request, response, token) {
    setSessionCookie(request, response, token);
}

async function signup(request, response) {
    enforceIpRateLimit(request);
    requireSameOrigin(request);
    const body = await readJsonBody(request);
    const phone = normalizePhone(body.phone);
    enforcePhoneRateLimit(phone);
    const password = validatePassword(body.password);
    const userId = randomUUID();
    const salt = randomBytes(16);
    const passwordHash = await derivePasswordHash(password, salt);
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashSessionToken(token);
    const connection = await getPool().getConnection();

    try {
        await connection.beginTransaction();
        await connection.execute(
            "INSERT INTO sarki_users (id, phone_e164, password_salt, password_hash) VALUES (?, ?, ?, ?)",
            [userId, phone, salt, passwordHash],
        );
        await connection.execute(
            "INSERT INTO sarki_wallets (user_id) VALUES (?)",
            [userId],
        );
        await connection.execute(
            "INSERT INTO sarki_sessions (token_hash, user_id, expires_at) VALUES (?, ?, NULL)",
            [tokenHash, userId],
        );
        await connection.commit();
        issueSessionCookie(request, response, token);
        sendJson(response, 201, {
            user: {
                phone,
                balanceKobo: "0",
            },
        });
    } catch (error) {
        await connection.rollback().catch(() => {});
        if (error.code === "ER_DUP_ENTRY") {
            throw new HttpError(409, "An account already exists for that phone number. Log in instead.");
        }
        throw error;
    } finally {
        connection.release();
    }
}

async function login(request, response) {
    enforceIpRateLimit(request);
    requireSameOrigin(request);
    const body = await readJsonBody(request);
    const phone = normalizePhone(body.phone);
    enforcePhoneRateLimit(phone);
    const password = validatePassword(body.password);
    const [accountRows] = await getPool().execute(
        `SELECT u.id, u.phone_e164, u.password_salt, u.password_hash, w.balance_kobo
         FROM sarki_users AS u
         JOIN sarki_wallets AS w ON w.user_id = u.id
         WHERE u.phone_e164 = ?`,
        [phone],
    );
    const account = accountRows[0];
    const candidateHash = await derivePasswordHash(
        password,
        account ? Buffer.from(account.password_salt) : DUMMY_PASSWORD_SALT,
    );
    const savedHash = account ? Buffer.from(account.password_hash) : Buffer.alloc(PASSWORD_HASH_BYTES);
    const passwordMatches = timingSafeEqual(candidateHash, savedHash);

    if (!account || !passwordMatches) {
        throw new HttpError(401, "Phone number or password is incorrect.");
    }

    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashSessionToken(token);
    await getPool().execute(
        "INSERT INTO sarki_sessions (token_hash, user_id, expires_at) VALUES (?, ?, NULL)",
        [tokenHash, account.id],
    );
    issueSessionCookie(request, response, token);
    sendJson(response, 200, {
        user: {
            phone: account.phone_e164,
            balanceKobo: String(account.balance_kobo),
        },
    });
}

async function accountForSession(request) {
    const token = readSessionToken(request);
    if (!token) return null;

    const [rows] = await getPool().execute(
        `SELECT u.id, u.phone_e164, w.balance_kobo
         FROM sarki_sessions AS s
         JOIN sarki_users AS u ON u.id = s.user_id
         JOIN sarki_wallets AS w ON w.user_id = u.id
         WHERE s.token_hash = ? AND (s.expires_at IS NULL OR s.expires_at > CURRENT_TIMESTAMP)`,
        [hashSessionToken(token)],
    );
    return rows[0] || null;
}

async function currentUser(request) {
    const account = await accountForSession(request);
    return account
        ? { phone: account.phone_e164, balanceKobo: String(account.balance_kobo) }
        : null;
}

async function requireAccount(request) {
    const account = await accountForSession(request);
    if (!account) throw new HttpError(401, "Log in to continue.");
    return account;
}

async function listDataOrders(request, response) {
    const account = await requireAccount(request);
    const orders = await listRecentDataOrders(getPool(), account.id);
    return sendJson(response, 200, { orders });
}

async function purchaseData(request, response) {
    enforceIpRateLimit(request);
    requireSameOrigin(request);
    const account = await requireAccount(request);
    consumeRateLimit(`data-purchase:${account.id}`, RATE_LIMIT_DATA_PURCHASES_PER_ACCOUNT);
    const body = await readJsonBody(request);
    const phone = normalizePhone(body.phone);
    if (typeof body.portedNumber !== "boolean") {
        throw new HttpError(400, "Choose whether this phone number has been ported to MTN.");
    }

    try {
        const result = await purchaseMtnBundle(getPool(), {
            userId: account.id,
            phone,
            idempotencyKey: body.idempotencyKey,
            portedNumber: body.portedNumber,
            offerId: body.offerId,
        });
        return sendJson(response, 200, result);
    } catch (error) {
        if (error instanceof DataSalesError) {
            throw new HttpError(error.status, error.message);
        }
        throw error;
    }
}

async function handleApi(request, response, pathname) {
    if (pathname === "/api/data/plans" && request.method === "GET") {
        return sendJson(response, 200, { plans: listMtnDataPlans() });
    }

    if (pathname === "/api/health" && request.method === "GET") {
        await getPool().execute("SELECT 1");
        return sendJson(response, 200, { status: "ok" });
    }

    if (pathname === "/api/auth/me" && request.method === "GET") {
        const user = await currentUser(request);
        return sendJson(response, 200, { user });
    }

    if (pathname === "/api/auth/signup" && request.method === "POST") {
        return signup(request, response);
    }

    if (pathname === "/api/auth/login" && request.method === "POST") {
        return login(request, response);
    }

    if (pathname === "/api/data/orders" && request.method === "GET") {
        return listDataOrders(request, response);
    }

    if (pathname === "/api/data/purchase" && request.method === "POST") {
        return purchaseData(request, response);
    }

    return sendJson(response, 404, { error: "API endpoint not found." });
}

const server = createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    let pathname;

    try {
        pathname = new URL(request.url || "/", "http://localhost").pathname;
        if (pathname.startsWith("/api/")) {
            await handleApi(request, response, pathname);
            return;
        }

        if (request.method !== "GET" && request.method !== "HEAD") {
            return sendJson(response, 405, { error: "Method not allowed." }, { Allow: "GET, HEAD" });
        }

        const html = await readFile(landingPagePath);
        response.writeHead(200, {
            "Cache-Control": "no-store",
            "Content-Type": "text/html; charset=utf-8",
            "Referrer-Policy": "strict-origin-when-cross-origin",
        });
        response.end(request.method === "HEAD" ? undefined : html);
    } catch (error) {
        if (response.headersSent) {
            response.destroy();
            return;
        }
        const status = Number.isInteger(error.status) ? error.status : 500;
        if (status >= 500) {
            console.error("SARKI request failed:", error.message);
        }
        const headers = error.retryAfterSeconds
            ? { "Retry-After": String(error.retryAfterSeconds) }
            : {};
        sendJson(response, status, {
            error: status >= 500 && !error.expose
                ? "SARKI could not complete that request. Please try again."
                : error.message,
        }, headers);
    }
});

server.on("error", (error) => {
    console.error("SARKI server error:", error.message);
    process.exitCode = 1;
});

async function start() {
    if (pool) {
        await pool.execute("SELECT 1");
    } else {
        console.warn("MySQL is not configured; account services will return an error until it is.");
    }
    server.listen(PORT, HOST, () => {
        console.log(`SARKI Data House listening on ${HOST}:${PORT}`);
    });
}

start().catch(async (error) => {
    console.error("Could not start SARKI Data House:", error.message);
    await closePool().catch(() => {});
    process.exitCode = 1;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
        server.close(async () => {
            await closePool().catch(() => {});
        });
    });
}
