import { Router } from "express";
import { rateLimit } from "../../middleware/rateLimit.js";
import {
  addVariantHandler,
  adjustStockHandler,
  archiveVariantHandler,
  confirmBulkImportHandler,
  createProductHandler,
  getProductHandler,
  listProductsHandler,
  publishProductHandler,
  restoreVariantHandler,
  setProductOptionsHandler,
  softDeleteProductHandler,
  startBulkImportHandler,
  unpublishProductHandler,
  updateProductHandler,
  updateVariantHandler,
} from "./controller.js";

const productsRouter: Router = Router();

// Bulk import routes MUST be registered before the :productId routes —
// Express matches in order, and "/bulk/import" would otherwise be
// swallowed as productId "bulk". Both phases are write-adjacent and
// write-heavy, so each gets its own per-route limiter (60/min).
const bulkImportRateLimit = rateLimit({ windowMs: 60_000, max: 60 });
const writeRateLimit = rateLimit({ windowMs: 60_000, max: 60 });

productsRouter.post("/", createProductHandler);
productsRouter.get("/", listProductsHandler);
productsRouter.post("/bulk/import", bulkImportRateLimit, startBulkImportHandler);
productsRouter.post("/bulk/confirm", bulkImportRateLimit, confirmBulkImportHandler);
productsRouter.get("/:productId", getProductHandler);
productsRouter.patch("/:productId", updateProductHandler);
productsRouter.delete("/:productId", softDeleteProductHandler);
productsRouter.post("/:productId/publish", publishProductHandler);
productsRouter.post("/:productId/unpublish", unpublishProductHandler);
productsRouter.post("/:productId/stock-adjustments", adjustStockHandler);
// Options + variants (dimensions are changed only through PUT /options).
productsRouter.put("/:productId/options", writeRateLimit, setProductOptionsHandler);
productsRouter.post("/:productId/variants", writeRateLimit, addVariantHandler);
productsRouter.patch("/:productId/variants/:variantId", writeRateLimit, updateVariantHandler);
productsRouter.post("/:productId/variants/:variantId/archive", writeRateLimit, archiveVariantHandler);
productsRouter.post("/:productId/variants/:variantId/restore", writeRateLimit, restoreVariantHandler);

export { productsRouter };
