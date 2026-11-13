# Dashboard announcements

Route group: dashboard. Auth: bearer + store.

- `GET /api/dashboard/announcements` returns all active published announcements targeted to every tier or the store's resolved tier. A store without a subscription resolves to `STARTER`.
- `POST /api/dashboard/announcements/:announcementId/view` records one view for the tenant. It is idempotent and returns `204`; drafts, inactive announcements, and announcements targeted to another tier return `404 ANNOUNCEMENT_NOT_FOUND`.

Responses include id, title, body, targetTier, publishedAt, and createdAt. Timestamps are UTC ISO-8601.
