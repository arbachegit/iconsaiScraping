import { Router } from "express";
import {
  getDbModelOverview,
  getDbModelTableDetails,
  getDbModelTableSamples,
} from "../services/db-model.js";
import logger from "../utils/logger.js";

const router = Router();

function requireAdmin(req, res, next) {
  const role = req.user?.role || "user";
  const isAdmin =
    req.user?.is_admin || role === "admin" || role === "superadmin";

  if (!isAdmin) {
    return res.status(403).json({
      success: false,
      error: "Admin access required",
    });
  }

  return next();
}

router.use(requireAdmin);

router.get("/overview", async (_req, res) => {
  try {
    const data = await getDbModelOverview();
    return res.json(data);
  } catch (error) {
    logger.error("db_model_overview_error", { error });
    return res.status(500).json({
      success: false,
      error: "Failed to load database model overview",
    });
  }
});

router.get("/table/:tableName", async (req, res) => {
  try {
    const tableName = String(req.params.tableName || "").trim();
    if (!tableName) {
      return res.status(400).json({
        success: false,
        error: "Table name is required",
      });
    }

    const data = await getDbModelTableDetails(tableName);
    if (!data) {
      return res.status(404).json({
        success: false,
        error: "Table not found in the exposed public schema",
      });
    }

    return res.json(data);
  } catch (error) {
    logger.error("db_model_table_error", {
      table: req.params.tableName,
      error,
    });
    return res.status(500).json({
      success: false,
      error: "Failed to load table details",
    });
  }
});

router.get("/table/:tableName/samples", async (req, res) => {
  try {
    const tableName = String(req.params.tableName || "").trim();
    if (!tableName) {
      return res.status(400).json({
        success: false,
        error: "Table name is required",
      });
    }

    const data = await getDbModelTableSamples(tableName);
    if (!data) {
      return res.status(404).json({
        success: false,
        error: "Table not found",
      });
    }

    return res.json({ success: true, ...data });
  } catch (error) {
    logger.error("db_model_samples_error", {
      table: req.params.tableName,
      error,
    });
    return res.status(500).json({
      success: false,
      error: "Failed to load table samples",
    });
  }
});

export default router;
