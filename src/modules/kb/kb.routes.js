import express from "express";
import authenticate from "../../middleware/authenticate.js";
import authorizePermission from "../../middleware/authorizePermission.js";
import kbController from "./kb.controller.js";
import {
  validateArticleIdentifier,
  validateCategoryId,
} from "./kb.validation.js";

const router = express.Router();

// Enforce authentication on all KB endpoints
router.use(authenticate);

// Overview
router.get("/overview", kbController.getOverview);

// Authors directory for assignment / filtering
router.get("/authors", kbController.listAuthors);

// KB write access is governed by the configurable "Knowledge Base"
// permission: 'Publish & edit' grants full authoring (incl. publishing and
// category management), 'Draft only' allows drafting but not publishing,
// 'View only' and 'Not allowed' deny all writes. Reads stay open to every
// authenticated role (unchanged).
const requireKbDraft = authorizePermission("publish_kb", "DRAFT");
const requireKbFull = authorizePermission("publish_kb", "FULL");

// Categories
router.get("/categories", kbController.listCategories);
router.post("/categories", requireKbFull, kbController.createCategory);
router.patch("/categories/reorder", requireKbFull, kbController.reorderCategories);
router.patch("/categories/:id", requireKbFull, validateCategoryId, kbController.updateCategory);
router.delete("/categories/:id", requireKbFull, validateCategoryId, kbController.deleteCategory);

// Articles
router.get("/articles", kbController.listArticles);
router.get("/articles/export", kbController.exportArticlesCsv);
router.post("/articles", requireKbDraft, kbController.createArticle);
router.get("/articles/:id", validateArticleIdentifier, kbController.getArticle);
router.patch("/articles/:id", requireKbDraft, validateArticleIdentifier, kbController.updateArticle);
router.delete("/articles/:id", requireKbDraft, validateArticleIdentifier, kbController.deleteArticle);
router.post("/articles/:id/publish", requireKbFull, validateArticleIdentifier, kbController.publishArticle);
router.post("/articles/:id/feedback", validateArticleIdentifier, kbController.voteFeedback);
router.get("/articles/:id/related", validateArticleIdentifier, kbController.getRelatedArticles);

// AI suggestion (authoring aid — same KB authoring requirement)
router.post("/ai/suggest", requireKbDraft, kbController.generateAiSuggestion);

export default router;

