import mysql from "mysql2/promise";

const MYSQL_CONFIGURATION_ERROR =
    "Account creation requires a MySQL database. Configure MYSQL_URL or the MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, and MYSQL_DATABASE settings.";

function buildPoolOptions() {
    const poolDefaults = {
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        supportBigNumbers: true,
        bigNumberStrings: true,
        timezone: "Z",
        charset: "utf8mb4",
    };
    const hasMySqlCredentials = [
        "MYSQL_HOST",
        "MYSQL_USER",
        "MYSQL_PASSWORD",
        "MYSQL_DATABASE",
    ].some((name) => process.env[name] !== undefined && process.env[name] !== "");
    const hasAnyMySqlSettings = [
        "MYSQL_HOST",
        "MYSQL_PORT",
        "MYSQL_USER",
        "MYSQL_PASSWORD",
        "MYSQL_DATABASE",
    ].some((name) => process.env[name] !== undefined && process.env[name] !== "");
    const connectionString = process.env.MYSQL_URL
        || (!hasMySqlCredentials ? process.env.DATABASE_URL : "");

    if (connectionString) {
        let url;
        try {
            url = new URL(connectionString);
        } catch {
            throw new Error("DATABASE_URL must be a valid MySQL connection URL.");
        }

        if (url.protocol !== "mysql:" && url.protocol !== "mysql2:") {
            throw new Error("DATABASE_URL must use the mysql:// or mysql2:// protocol.");
        }

        const database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
        const port = url.port ? Number(url.port) : 3306;
        if (!url.hostname || !url.username || !database || !Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error("DATABASE_URL must include a MySQL host, username, database, and valid port.");
        }

        const options = {
            ...poolDefaults,
            host: url.hostname,
            port,
            user: decodeURIComponent(url.username),
            password: decodeURIComponent(url.password),
            database,
        };
        const useTls = process.env.MYSQL_SSL === "true"
            || ["true", "1"].includes(url.searchParams.get("ssl")?.toLowerCase() || "");
        if (useTls) options.ssl = { rejectUnauthorized: true };
        return options;
    }

    if (!hasAnyMySqlSettings) return null;

    const missing = ["MYSQL_HOST", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_DATABASE"]
        .filter((name) => !Object.hasOwn(process.env, name) || process.env[name] === "");
    if (missing.length > 0) {
        throw new Error(`Missing MySQL environment settings: ${missing.join(", ")}.`);
    }

    const port = Number(process.env.MYSQL_PORT || 3306);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("MYSQL_PORT must be a valid TCP port.");
    }

    const options = {
        ...poolDefaults,
        host: process.env.MYSQL_HOST,
        port,
        user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD,
        database: process.env.MYSQL_DATABASE,
    };
    if (process.env.MYSQL_SSL === "true") options.ssl = { rejectUnauthorized: true };
    return options;
}

let poolOptions = null;
let configurationError = null;
try {
    poolOptions = buildPoolOptions();
} catch (error) {
    configurationError = error.message;
}

export const pool = poolOptions ? mysql.createPool(poolOptions) : null;
export const databaseConfigurationError = configurationError;

export function getPool() {
    if (!pool) {
        const error = new Error(MYSQL_CONFIGURATION_ERROR);
        error.status = 503;
        error.expose = true;
        throw error;
    }
    return pool;
}

export async function closePool() {
    if (pool) await pool.end();
}
