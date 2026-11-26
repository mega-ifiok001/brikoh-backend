# OpenAPI documentation

The Swagger/OpenAPI 3.1 specification for Brikoh authentication,
account security, staff invite acceptance, and platform-admin authentication.
is in `oja-backend/public/openapi/auth.yaml` so it ships with the backend.

## View the docs

Run the backend from the `oja-backend` directory and open
`http://localhost:4000/api-docs` for the interactive Swagger UI. The backend
serves the UI assets locally. For offline viewing, import
`oja-backend/public/openapi/auth.yaml` into [Swagger Editor](https://editor.swagger.io/)
or another OpenAPI 3.1 compatible viewer. The API server in the spec is relative
to the current origin, which lets **Try it out** target the same backend that
served the UI.

## Use the examples for testing

- Expand an operation and use its request-body example as the JSON payload.
- Fake credentials, IDs, authorization codes, and tokens in examples are
  placeholders. Register/login or use the relevant email/invitation flow to
  obtain real values before testing dependent endpoints.
- For bearer protected calls, click **Authorize** and enter the access token
  without adding `Bearer `; Swagger UI adds the scheme prefix.
- Merchant and platform-admin access tokens are separate and cannot be used
  interchangeably. Refresh tokens are rotated: replace the old token with the
  one returned from each successful refresh.
- Never test account deletion or administrator 2FA operations against
  production data using example values.
