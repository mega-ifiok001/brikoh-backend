import { Router } from "express";
import {
  createCategoryHandler,
  createUnitHandler,
  deleteCategoryHandler,
  deleteUnitHandler,
  getCategoryHandler,
  getUnitHandler,
  listCategoriesHandler,
  listUnitsHandler,
  updateCategoryHandler,
  updateUnitHandler,
} from "./controller.js";

const categoriesRouter: Router = Router();

categoriesRouter.post("/", createCategoryHandler);
categoriesRouter.get("/", listCategoriesHandler);
categoriesRouter.get("/:categoryId", getCategoryHandler);
categoriesRouter.patch("/:categoryId", updateCategoryHandler);
categoriesRouter.delete("/:categoryId", deleteCategoryHandler);

const unitsRouter: Router = Router();

unitsRouter.post("/", createUnitHandler);
unitsRouter.get("/", listUnitsHandler);
unitsRouter.get("/:unitId", getUnitHandler);
unitsRouter.patch("/:unitId", updateUnitHandler);
unitsRouter.delete("/:unitId", deleteUnitHandler);

export { categoriesRouter, unitsRouter };
