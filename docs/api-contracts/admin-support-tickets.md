# Admin support tickets

Route group: admin. Auth: admin bearer.

- `GET /tickets` requires `admin:support.tickets.view`; filters status, priority, assignedAdminId, cursor, limit (1–50), and sorts active statuses first then oldest first.
- `GET /tickets/:ticketId` requires view permission and returns the ticket, store projection, and paginated messages.
- `POST /tickets/:ticketId/assign` requires manage permission and accepts `{ "adminId": "uuid | null" }`; an unknown or inactive admin is `404 ADMIN_NOT_FOUND`.
- `PATCH /tickets/:ticketId/status` requires manage permission and accepts `{ "status": "OPEN | IN_PROGRESS | RESOLVED | CLOSED" }`.
- `POST /tickets/:ticketId/messages` requires manage permission and accepts `{ "body": "string" }`.

`RESOLVED` sets `resolvedAt`, `CLOSED` sets `closedAt`, and closed tickets are terminal (`409 TICKET_CLOSED`). Admin reads/actions are audit logged. Admin replies send a best-effort, deduplicated owner email without including their body in audit data.
