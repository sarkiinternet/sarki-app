import { randomUUID } from "node:crypto";

export const DATA_OFFERS = Object.freeze({
    "mtn-1gb": Object.freeze({
        network: 1,
        plan: 669,
        amountKobo: 45000,
        name: "MTN 1 GB",
        size: "1 GB",
    }),
    "mtn-2gb": Object.freeze({
        network: 1,
        plan: 573,
        amountKobo: 80000,
        name: "MTN 2 GB",
        size: "2 GB",
    }),
    "mtn-3gb": Object.freeze({
        network: 1,
        plan: 572,
        amountKobo: 110000,
        name: "MTN 3 GB",
        size: "3 GB",
    }),
    "mtn-10gb": Object.freeze({
        network: 1,
        plan: 652,
        amountKobo: 300000,
        name: "MTN 10 GB",
        size: "10 GB",
    }),
});

const ALRAHUZ_DATA_URL = "https://alrahuzdata.com.ng/api/data/";
const PROVIDER_TIMEOUT_MS = 20000;
const IDEMPOTENCY_KEY_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class DataSalesError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
        this.expose = status < 500;
    }
}

export function listMtnDataPlans() {
    return Object.entries(DATA_OFFERS).map(([offerId, offer]) => ({
        offerId,
        size: offer.size,
        amountKobo: String(offer.amountKobo),
    }));
}

function providerPhoneNumber(e164) {
    if (!e164.startsWith("+234")) {
        throw new DataSalesError(400, "MTN data purchases require a Nigerian phone number.");
    }
    return `0${e164.slice(4)}`;
}

function parseProviderBody(text) {
    if (!text.trim()) return null;
    try {
        return JSON.parse(text);
    } catch {
        return text.trim().slice(0, 200);
    }
}

function providerReference(payload) {
    if (!payload || typeof payload !== "object") return null;
    const reference = payload.reference
        ?? payload.Reference
        ?? payload.request_id
        ?? payload.transaction_id
        ?? payload.transactionId;
    if (typeof reference !== "string" && typeof reference !== "number") return null;
    const safeReference = String(reference).trim();
    return /^[A-Za-z0-9._:-]{1,128}$/.test(safeReference) ? safeReference : null;
}

function providerOutcome(response, payload) {
    const successFlag = payload && typeof payload === "object"
        ? payload.success ?? payload.Success
        : undefined;
    const statusValue = payload && typeof payload === "object"
        ? payload.status ?? payload.Status ?? payload.state ?? payload.State
        : payload;
    const normalizedStatus = typeof statusValue === "string"
        ? statusValue.trim().toLowerCase()
        : "";

    const isExplicitFailure = (
        successFlag === false
        || ["false", "0", "no"].includes(String(successFlag).toLowerCase())
        || ["failed", "failure", "rejected", "error", "unsuccessful", "cancelled", "canceled", "declined"].includes(normalizedStatus)
    );
    if (isExplicitFailure || (response.status >= 400 && response.status < 500)) {
        return "failed";
    }

    if (["pending", "processing", "queued", "initiated", "in progress", "in_progress"].includes(normalizedStatus)) {
        return "pending";
    }

    if (
        successFlag === true
        || ["true", "1", "yes"].includes(String(successFlag).toLowerCase())
        || ["success", "successful", "completed", "delivered"].includes(normalizedStatus)
    ) {
        return "successful";
    }

    if (response.ok) return "submitted";
    return "pending";
}

function orderMessage(status, product) {
    if (status === "successful") return `Your ${product} data purchase was confirmed.`;
    if (status === "submitted") return `The provider accepted your ${product} order. If the bundle does not arrive, check the provider portal before retrying.`;
    if (status === "failed") return "The provider rejected the order. Your wallet has been refunded.";
    return "The provider response is not yet confirmed. Your balance is held to prevent a duplicate purchase.";
}

function serializeOrder(row) {
    const offer = Object.values(DATA_OFFERS).find((candidate) => candidate.plan === Number(row.plan_id));
    return {
        id: row.id,
        product: offer?.name || "MTN data bundle",
        recipient: row.recipient_phone_e164,
        amountKobo: String(row.amount_kobo),
        status: row.status,
        idempotencyKey: row.idempotency_key,
        providerReference: row.provider_reference || null,
        createdAt: row.created_at instanceof Date
            ? row.created_at.toISOString()
            : String(row.created_at),
    };
}

async function createOrderAndDebit(pool, { userId, phone, idempotencyKey, portedNumber, offer }) {
    const connection = await pool.getConnection();
    let transactionOpen = false;

    try {
        await connection.beginTransaction();
        transactionOpen = true;

        const [walletRows] = await connection.execute(
            "SELECT balance_kobo FROM sarki_wallets WHERE user_id = ? FOR UPDATE",
            [userId],
        );
        const wallet = walletRows[0];
        if (!wallet) throw new DataSalesError(404, "A SARKI wallet could not be found for this account.");

        const [existingRows] = await connection.execute(
            `SELECT id, idempotency_key, recipient_phone_e164, plan_id, amount_kobo, status, provider_reference, created_at
             FROM sarki_data_orders
             WHERE user_id = ? AND idempotency_key = ?
             LIMIT 1
             FOR UPDATE`,
            [userId, idempotencyKey],
        );
        if (existingRows[0]) {
            await connection.commit();
            transactionOpen = false;
            return {
                order: existingRows[0],
                balanceKobo: String(wallet.balance_kobo),
                replayed: true,
            };
        }

        const [unresolvedRows] = await connection.execute(
            `SELECT id
             FROM sarki_data_orders
             WHERE user_id = ? AND status IN ('processing', 'pending')
             ORDER BY created_at DESC
             LIMIT 1
             FOR UPDATE`,
            [userId],
        );
        if (unresolvedRows[0]) {
            throw new DataSalesError(
                409,
                "An earlier data order is awaiting provider confirmation. Do not place another order yet.",
            );
        }

        const balance = BigInt(wallet.balance_kobo);
        if (balance < BigInt(offer.amountKobo)) {
            const price = (offer.amountKobo / 100).toLocaleString("en-NG");
            throw new DataSalesError(409, `Your wallet balance is too low for the ${offer.name} bundle (₦${price}).`);
        }

        await connection.execute(
            "UPDATE sarki_wallets SET balance_kobo = balance_kobo - ? WHERE user_id = ?",
            [offer.amountKobo, userId],
        );

        const orderId = randomUUID();
        await connection.execute(
            `INSERT INTO sarki_data_orders
                (id, user_id, idempotency_key, recipient_phone_e164, network_id, plan_id, amount_kobo, ported_number, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'processing')`,
            [
                orderId,
                userId,
                idempotencyKey,
                phone,
                offer.network,
                offer.plan,
                offer.amountKobo,
                portedNumber,
            ],
        );
        await connection.commit();
        transactionOpen = false;

        return {
            order: {
                id: orderId,
                idempotency_key: idempotencyKey,
                recipient_phone_e164: phone,
                plan_id: offer.plan,
                amount_kobo: String(offer.amountKobo),
                status: "processing",
                provider_reference: null,
                created_at: new Date(),
            },
            balanceKobo: String(balance - BigInt(offer.amountKobo)),
            replayed: false,
        };
    } catch (error) {
        if (transactionOpen) await connection.rollback().catch(() => {});
        throw error;
    } finally {
        connection.release();
    }
}

async function updateOrderStatus(pool, orderId, status, reference = null) {
    const connection = await pool.getConnection();
    let transactionOpen = false;

    try {
        await connection.beginTransaction();
        transactionOpen = true;

        const [orderRows] = await connection.execute(
            `SELECT user_id, amount_kobo, status
             FROM sarki_data_orders
             WHERE id = ?
             FOR UPDATE`,
            [orderId],
        );
        const order = orderRows[0];
        if (!order) throw new Error("Data order disappeared before provider settlement.");

        if (order.status === "processing") {
            if (status === "failed") {
                await connection.execute(
                    "UPDATE sarki_wallets SET balance_kobo = balance_kobo + ? WHERE user_id = ?",
                    [order.amount_kobo, order.user_id],
                );
            }

            await connection.execute(
                `UPDATE sarki_data_orders
                 SET status = ?, provider_reference = COALESCE(?, provider_reference)
                 WHERE id = ?`,
                [status, reference, orderId],
            );
        }

        const [walletRows] = await connection.execute(
            "SELECT balance_kobo FROM sarki_wallets WHERE user_id = ?",
            [order.user_id],
        );
        await connection.commit();
        transactionOpen = false;
        return String(walletRows[0]?.balance_kobo ?? 0);
    } catch (error) {
        if (transactionOpen) await connection.rollback().catch(() => {});
        throw error;
    } finally {
        connection.release();
    }
}

async function loadOrder(pool, userId, orderId) {
    const [rows] = await pool.execute(
        `SELECT id, idempotency_key, recipient_phone_e164, plan_id, amount_kobo, status, provider_reference, created_at
         FROM sarki_data_orders
         WHERE user_id = ? AND id = ?
         LIMIT 1`,
        [userId, orderId],
    );
    return rows[0] || null;
}

export async function purchaseMtnBundle(pool, {
    userId,
    phone,
    idempotencyKey,
    portedNumber,
    offerId,
}) {
    const offer = typeof offerId === "string" ? DATA_OFFERS[offerId] : null;
    if (!offer) {
        throw new DataSalesError(400, "Choose a valid MTN data plan.");
    }

    const token = process.env.ALRAHUZ_API_TOKEN?.trim();
    if (!token) {
        throw new DataSalesError(503, "Data purchases are not configured yet.");
    }
    const mobileNumber = providerPhoneNumber(phone);
    if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
        throw new DataSalesError(400, "Refresh the purchase form and try again.");
    }
    if (typeof portedNumber !== "boolean") {
        throw new DataSalesError(400, "Choose whether this phone number has been ported to MTN.");
    }

    const created = await createOrderAndDebit(pool, {
        userId,
        phone,
        idempotencyKey,
        portedNumber,
        offer,
    });
    if (created.replayed) {
        const order = serializeOrder(created.order);
        return {
            order,
            balanceKobo: created.balanceKobo,
            message: orderMessage(created.order.status, order.product),
            replayed: true,
        };
    }

    let outcome = "pending";
    let reference = null;
    try {
        const response = await fetch(ALRAHUZ_DATA_URL, {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
            headers: {
                Authorization: `Token ${token}`,
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: JSON.stringify({
                network: offer.network,
                mobile_number: mobileNumber,
                plan: offer.plan,
                Ported_number: portedNumber,
            }),
        });
        const bodyText = await response.text();
        const payload = parseProviderBody(bodyText);
        outcome = providerOutcome(response, payload);
        reference = providerReference(payload);
    } catch {
        // A timeout or dropped connection may happen after the provider accepted the order.
        // Keep the debit and mark it pending rather than risk a duplicate purchase.
        outcome = "pending";
    }

    const balanceKobo = await updateOrderStatus(pool, created.order.id, outcome, reference);
    const order = await loadOrder(pool, userId, created.order.id);
    if (!order) throw new Error("Data order could not be reloaded after provider response.");
    const serializedOrder = serializeOrder(order);

    return {
        order: serializedOrder,
        balanceKobo,
        message: orderMessage(order.status, serializedOrder.product),
        replayed: false,
    };
}

export async function listRecentDataOrders(pool, userId) {
    const [rows] = await pool.execute(
        `SELECT id, idempotency_key, recipient_phone_e164, plan_id, amount_kobo, status, provider_reference, created_at
         FROM sarki_data_orders
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT 10`,
        [userId],
    );
    return rows.map(serializeOrder);
}
