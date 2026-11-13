# Dashboard support tickets

Route group: dashboard. Auth: bearer + store, owner only.

- `POST /tickets` creates an `OPEN` ticket plus its first merchant message.
- `GET /tickets` lists only the authenticated store’s tickets; filters: `status`, `priority`, `cursor`, `limit` (1–50).
- `GET /tickets/:ticketId` returns a ticket and chronological cursor-paginated messages (max 50); cross-tenant IDs are `404 TICKET_NOT_FOUND`.
- `POST /tickets/:ticketId/messages` adds a merchant message; closed tickets return `409 TICKET_CLOSED`.

Ticket responses include identifiers, subject, priority, status, assigned admin, lifecycle timestamps, and UTC timestamps. Message responses include a safe typed-author projection, body, and UTC timestamp. Standard error bodies apply; `403` is non-owner.
