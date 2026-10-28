require("dotenv").config();
const { randomUUID, createHash } = require("crypto");
const express = require("express");
const cors = require("cors");
function requireApiKey(req, res, next) {
    const apiKey = req.header("x-api-key");

    if (!apiKey || apiKey !== process.env.API_KEY) {
        return res.status(401).json({
            error: "Missing or invalid API key",
        });
    }

    next();
}


function createRequestHash(slotId, name, email) {
    const requestData = JSON.stringify({
        slot_id: slotId,
        name: name,
        email: email,
    });

    return createHash("sha256")
        .update(requestData)
        .digest("hex");
}


async function bookingRateLimiter(req, res, next) {
    const rawEmail = req.body?.email;

    if (typeof rawEmail !== "string" || !rawEmail.trim()) {
        return next();
    }

    const email = rawEmail.trim().toLowerCase();

    let client;

    try {
        client = await pool.connect();

        await client.query("BEGIN");

        await client.query(
            "SELECT pg_advisory_xact_lock(hashtext($1)::bigint)",
            [email]
        );

        const countResult = await client.query(
            `SELECT COUNT(*)::int AS attempts
             FROM booking_attempts
             WHERE email = $1
               AND attempted_at > NOW() - INTERVAL '60 seconds'`,
            [email]
        );

        const attempts = countResult.rows[0].attempts;

        if (attempts >= 5) {
            const retryResult = await client.query(
                `SELECT GREATEST(
                    1,
                    CEIL(
                        EXTRACT(
                            EPOCH FROM (
                                MIN(attempted_at)
                                + INTERVAL '60 seconds'
                                - NOW()
                            )
                        )
                    )::int
                ) AS retry_after
                FROM booking_attempts
                WHERE email = $1
                  AND attempted_at > NOW() - INTERVAL '60 seconds'`,
                [email]
            );

            await client.query("COMMIT");

            return res
                .set("Retry-After", String(retryResult.rows[0].retry_after))
                .status(429)
                .json({
                    error: "Too many booking attempts. Please try again later.",
                });
        }

        await client.query(
            `INSERT INTO booking_attempts (email)
             VALUES ($1)`,
            [email]
        );

        await client.query("COMMIT");

        return next();

    } catch (error) {
        if (client) {
            try {
                await client.query("ROLLBACK");
            } catch (rollbackError) {
                console.error(
                    "Rate-limit rollback failed:",
                    rollbackError.message
                );
            }
        }

        console.error("Rate limiter failed:", error.message);

        return res.status(503).json({
            error: "Booking service temporarily unavailable",
        });

    } finally {
        if (client) {
            client.release();
        }
    }
}


const pool = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

const defaultAllowedOrigins = [
    "http://localhost:5173",
    "http://localhost:3000",
    "http://localhost:4173",
    "https://carepoint-clinic.vercel.app",
];

const corsOptions = {
    origin: (origin, callback) => {
        if (!origin) {
            return callback(null, true);
        }

        const envOrigins = [
            process.env.FRONTEND_URL,
            process.env.CLIENT_URL,
            ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(",") : []),
            ...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",") : []),
        ]
            .filter(Boolean)
            .map((o) => o.trim());

        if (envOrigins.includes("*") || process.env.CORS_ORIGIN === "*") {
            return callback(null, true);
        }

        const allOrigins = [...defaultAllowedOrigins, ...envOrigins];

        if (
            allOrigins.includes(origin) ||
            /^https:\/\/.*carepoint.*\.vercel\.app$/.test(origin) ||
            /^https:\/\/.*\.vercel\.app$/.test(origin) ||
            /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
        ) {
            return callback(null, true);
        }

        return callback(null, true);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    exposedHeaders: ["Retry-After"],
    optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));

app.use(express.json());
app.use(requireApiKey);

app.get("/health", (req, res) => {
    res.status(200).json({
        status: "ok",
        message: "Clinic booking API is running",
    });
});

app.get("/db-check", async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT NOW() AS current_time"
        );

        res.status(200).json({
            database: "connected",
            time: result.rows[0].current_time,
        });
    } catch (error) {
        console.error(
            "Database connection failed:",
            error.message
        );

        res.status(500).json({
            error: "Database connection failed",
        });
    }
});


app.get("/slots", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                s.id,
                s.provider,
                s.start,
                s."end",
                (b.id IS NULL) AS available
            FROM slots AS s
            LEFT JOIN bookings AS b
                ON b.slot_id = s.id
                AND b.status = 'confirmed'
            ORDER BY s.start ASC
        `);

        res.status(200).json({
            slots: result.rows,
        });
    } catch (error) {
        console.error("Failed to fetch slots:", error.message);

        res.status(500).json({
            error: "Failed to fetch slots",
        });
    }
});




app.post("/bookings", bookingRateLimiter, async (req, res) => {
    const slotId =
        typeof req.body?.slot_id === "string"
            ? req.body.slot_id.trim()
            : "";

    const name =
        typeof req.body?.name === "string"
            ? req.body.name.trim()
            : "";

    const email =
        typeof req.body?.email === "string"
            ? req.body.email.trim().toLowerCase()
            : "";

    const idempotencyKey = req.header("Idempotency-Key")?.trim();

    if (!slotId || !name || !email) {
        return res.status(400).json({
            error: "slot_id, name and email are required",
        });
    }

    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailPattern.test(email)) {
        return res.status(400).json({
            error: "Invalid email address",
        });
    }

    if (req.header("Idempotency-Key") !== undefined &&
        !idempotencyKey) {
        return res.status(400).json({
            error: "Idempotency-Key cannot be empty",
        });
    }

    const requestHash = idempotencyKey
        ? createRequestHash(slotId, name, email)
        : null;

    let client;
    let transactionStarted = false;

    try {
        client = await pool.connect();

        await client.query("BEGIN");
        transactionStarted = true;

        if (idempotencyKey) {
            const keyResult = await client.query(
                `INSERT INTO idempotency_keys (key, request_hash)
                 VALUES ($1, $2)
                 ON CONFLICT (key) DO NOTHING
                 RETURNING key`,
                [idempotencyKey, requestHash]
            );

            if (keyResult.rows.length === 0) {
                const existingKeyResult = await client.query(
                    `SELECT request_hash, response_status, response_body
                     FROM idempotency_keys
                     WHERE key = $1`,
                    [idempotencyKey]
                );

                const existingKey = existingKeyResult.rows[0];

                await client.query("ROLLBACK");
                transactionStarted = false;

                if (existingKey.request_hash !== requestHash) {
                    return res.status(422).json({
                        error: "Idempotency-Key was already used with a different request",
                    });
                }

                if (
                    existingKey.response_status === null ||
                    existingKey.response_body === null
                ) {
                    return res.status(409).json({
                        error: "Request is still being processed",
                    });
                }

                return res
                    .status(existingKey.response_status)
                    .json(existingKey.response_body);
            }
        }

        const slotResult = await client.query(
            `SELECT id, start
             FROM slots
             WHERE id = $1
             FOR UPDATE`,
            [slotId]
        );

        if (slotResult.rows.length === 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return res.status(404).json({
                error: "Slot not found",
            });
        }

        const slot = slotResult.rows[0];

        if (new Date(slot.start).getTime() <= Date.now()) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return res.status(400).json({
                error: "Slot has already started",
            });
        }

        const existingBooking = await client.query(
            `SELECT id
             FROM bookings
             WHERE slot_id = $1
               AND status = 'confirmed'`,
            [slotId]
        );

        if (existingBooking.rows.length > 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return res.status(409).json({
                error: "Slot is already booked",
            });
        }

        const bookingId = randomUUID();

        const bookingResult = await client.query(
            `INSERT INTO bookings
                (id, slot_id, name, email, status)
             VALUES ($1, $2, $3, $4, 'confirmed')
             RETURNING id, slot_id, name, email, status, created_at`,
            [bookingId, slotId, name, email]
        );

        const booking = bookingResult.rows[0];

        if (idempotencyKey) {
            await client.query(
                `UPDATE idempotency_keys
                 SET response_status = $2,
                     response_body = $3
                 WHERE key = $1`,
                [idempotencyKey, 201, booking]
            );
        }

        await client.query("COMMIT");
        transactionStarted = false;

        return res.status(201).json(booking);

    } catch (error) {
        if (client && transactionStarted) {
            try {
                await client.query("ROLLBACK");
            } catch (rollbackError) {
                console.error(
                    "Rollback failed:",
                    rollbackError.message
                );
            }
        }

        if (error.code === "23505") {
            return res.status(409).json({
                error: "Slot is already booked",
            });
        }

        console.error("Booking failed:", error.message);

        return res.status(500).json({
            error: "Failed to create booking",
        });

    } finally {
        if (client) {
            client.release();
        }
    }
});



app.get("/bookings/:id", async (req, res) => {
    const bookingId = req.params.id;

    try {
        const result = await pool.query(
            `SELECT id, slot_id, name, email, status, created_at
             FROM bookings
             WHERE id = $1`,
            [bookingId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                error: "Booking not found",
            });
        }

        return res.status(200).json(result.rows[0]);

    } catch (error) {
        console.error("Failed to retrieve booking:", error.message);

        return res.status(500).json({
            error: "Failed to retrieve booking",
        });
    }
});



app.get("/bookings", async (req, res) => {
    const email =
        typeof req.query.email === "string"
            ? req.query.email.trim().toLowerCase()
            : "";

    if (!email) {
        return res.status(400).json({
            error: "Email is required",
        });
    }

    const rawLimit = req.query.limit;
    let limit = 10;

    if (rawLimit !== undefined) {
        if (
            typeof rawLimit !== "string" ||
            !/^\d+$/.test(rawLimit)
        ) {
            return res.status(400).json({
                error: "Limit must be an integer between 1 and 50",
            });
        }

        limit = Number(rawLimit);

        if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
            return res.status(400).json({
                error: "Limit must be an integer between 1 and 50",
            });
        }
    }

    let cursor = null;

    if (req.query.cursor !== undefined) {
        try {
            const decoded = Buffer.from(
                req.query.cursor,
                "base64url"
            ).toString("utf8");

            cursor = JSON.parse(decoded);

            if (
                typeof cursor.created_at !== "string" ||
                Number.isNaN(Date.parse(cursor.created_at)) ||
                typeof cursor.id !== "string" ||
                !cursor.id
            ) {
                throw new Error("Invalid cursor fields");
            }
        } catch {
            return res.status(400).json({
                error: "Invalid cursor",
            });
        }
    }


    try {
        const values = [email];
        let cursorCondition = "";

        if (cursor) {
            values.push(cursor.created_at, cursor.id);
            cursorCondition = `
                AND (created_at, id) > ($2::timestamptz, $3::text)
            `;
        }

        values.push(limit + 1);
        const limitParameter = `$${values.length}`;

        console.log("Final SQL query:", `
    SELECT id, slot_id, name, email, status, created_at
    FROM bookings
    WHERE LOWER(email) = $1
    ${cursorCondition}
    ORDER BY created_at ASC, id ASC
    LIMIT ${limitParameter}
`);

        const result = await pool.query(
            `
               SELECT
            id,
            slot_id,
            name,
            email,
            status,
            to_char(
                created_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS created_at
        FROM bookings
        WHERE LOWER(email) = $1
        ${cursorCondition}
        ORDER BY created_at ASC, id ASC
        LIMIT ${limitParameter}
            `,
            values
        );

        console.log(
            "Rows returned by SQL:",
            result.rows.map((booking) => ({
                id: booking.id,
                slot_id: booking.slot_id,
                created_at: booking.created_at,
            }))
        );

        console.log(
            "Timestamp type:",
            typeof result.rows[0]?.created_at
        );

        console.log(
            "Full timestamp:",
            result.rows[0]?.created_at
        );

        const hasMore = result.rows.length > limit;
        const bookings = result.rows.slice(0, limit);

        let nextCursor = null;

        if (hasMore && bookings.length > 0) {
            const lastBooking = bookings[bookings.length - 1];

            nextCursor = Buffer.from(
                JSON.stringify({
                    created_at: lastBooking.created_at,
                    id: lastBooking.id,
                })
            ).toString("base64url");
        }

        return res.status(200).json({
            bookings,
            next_cursor: nextCursor,
        });
    } catch (error) {
        console.error("Failed to list bookings:", error.message);

        return res.status(500).json({
            error: "Failed to retrieve bookings",
        });
    }

});



app.delete("/bookings/:id", async (req, res) => {
    const bookingId = req.params.id;

    const email =
        typeof req.query.email === "string"
            ? req.query.email.trim().toLowerCase()
            : "";

    if (!email) {
        return res.status(400).json({
            error: "Email is required",
        });
    }

    try {
        const result = await pool.query(
            `UPDATE bookings
             SET status = 'cancelled'
             WHERE id = $1
               AND LOWER(email) = $2
               AND status = 'confirmed'
             RETURNING id, slot_id, name, email, status, created_at`,
            [bookingId, email]
        );

        if (result.rows.length > 0) {
            return res.status(200).json(result.rows[0]);
        }

        const existingBooking = await pool.query(
            `SELECT id, email, status
             FROM bookings
             WHERE id = $1`,
            [bookingId]
        );

        if (existingBooking.rows.length === 0) {
            return res.status(404).json({
                error: "Booking not found",
            });
        }

        if (existingBooking.rows[0].email.trim().toLowerCase() !== email) {
            return res.status(404).json({
                error: "Booking not found for this email",
            });
        }

        return res.status(409).json({
            error: "Booking is already cancelled",
        });

    } catch (error) {
        console.error("Failed to cancel booking:", error.message);

        return res.status(500).json({
            error: "Failed to cancel booking",
        });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
