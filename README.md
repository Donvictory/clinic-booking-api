A production-ready RESTful API for managing clinic appointment slots and bookings. Built with Node.js, Express, and PostgreSQL, this service features concurrency control using database locks, idempotent booking requests, transactional rate limiting, and cursor-based pagination.

Features
Concurrency-Safe Bookings: Uses PostgreSQL row-level locks (SELECT ... FOR UPDATE) and database transactions to eliminate race conditions and prevent double-booking.
Idempotency Protection: Supports the Idempotency-Key header with SHA-256 payload hashing to safely retry booking requests without creating duplicate records.
Transactional Rate Limiting: Enforces a rolling window of 5 booking attempts per 60 seconds per email using pg_advisory_xact_lock and returns Retry-After headers on HTTP 429.
Cursor-Based Pagination: Efficient keyset pagination for listing bookings (created_at, id) with base64url-encoded cursors.
API Key Authentication: Secures all application routes using the x-api-key header.
Configurable CORS: Dynamic origin verification supporting local environments, production domains, and preview URLs.
