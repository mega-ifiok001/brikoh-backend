# GET /api/admin/staff

Route group: admin. Auth: admin bearer. Permission: `admin:staff.view` (`SUPER_ADMIN` only).

Lists platform administrators and their current usable session: the newest refresh token that is both non-revoked and unexpired. The response never exposes token IDs, token values, or TOTP secrets.

```json
{
  "items": [{
    "id": "uuid",
    "email": "admin@example.com",
    "roleName": "SUPER_ADMIN",
    "isActive": true,
    "createdAt": "2026-08-01T00:00:00.000Z",
    "session": {
      "ipAddress": "203.0.113.7",
      "userAgent": "Mozilla/5.0",
      "createdAt": "2026-08-10T10:00:00.000Z"
    }
  }]
}
```

`session` is null when an admin has no usable refresh session. Every read is audit logged.
