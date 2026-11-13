# Admin announcements

Route group: admin. Auth: admin bearer. `SUPER_ADMIN` only.

- `POST /api/admin/announcements` creates a draft from `title`, `body`, and optional `targetTier` (`STARTER | PRO | ENTERPRISE | null`). It returns `201`; `publishedAt` is always null.
- `GET /api/admin/announcements` returns newest-first cursor-paginated announcements (default limit 50).
- `PATCH /api/admin/announcements/:announcementId` edits a draft or publishes it by setting `publishedAt`. Published announcements cannot be unpublished. `isActive: false` hides a published announcement immediately.
- `GET /api/admin/announcements/:announcementId/views` returns the announcement id and its exact unique-store `viewCount`.

All admin reads and mutations are audit logged. Standard error shape applies.
