import { AppError } from "../../lib/AppError.js";
import { presignProductImage } from "./service.js";
/** POST /api/dashboard/uploads/presign-product-image */
export async function presignProductImageHandler(req, res, next) {
    try {
        const tenant = req.tenant;
        if (tenant === undefined) {
            next(new AppError(401, "UNAUTHORIZED", "Authentication required"));
            return;
        }
        const result = await presignProductImage({ storeId: tenant.storeId, ...req.body });
        res.status(200).json(result);
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=controller.js.map