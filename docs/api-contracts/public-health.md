# GET /api/public/health

Route group: public
Auth: none
Rate-limited: no

Health-check endpoint proving the module pattern and error pipeline.
No tenant data involved.

## Request

No headers beyond defaults. No query params, no path params, no body.

## Success response

Status: `200`

```json
{
  "status": "ok",
  "uptime": 12.34,
  "timestamp": "2026-07-31T17:00:00.000Z"
}
```

- `uptime`: number — process uptime in seconds.
- `timestamp`: string — current server time, UTC ISO-8601, always ends in `Z`.

## Error responses

| Status | Condition |
| ------ | --------- |
| `404`  | Unknown route |

Uniform error body shape (see `docs/api-contracts/README.md`):

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Route GET /api/public/nope not found"
  }
}
```
