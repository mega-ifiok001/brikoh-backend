import { getHealth } from "./service.js";
/**
 * GET /api/public/health — returns process health. Thin controller:
 * delegates everything to the service, per the modules layering rule.
 */
export function getHealthHandler(req, res) {
    void req;
    res.status(200).json(getHealth());
}
//# sourceMappingURL=controller.js.map