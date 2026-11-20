declare module "swagger-ui-express" {
  import type { RequestHandler } from "express";

  const swaggerUi: {
    serve: RequestHandler[];
    setup(
      swaggerDocument?: unknown,
      options?: Record<string, unknown>,
      customOptions?: Record<string, unknown>,
      swaggerOptions?: Record<string, unknown>,
    ): RequestHandler;
  };

  export default swaggerUi;
}
