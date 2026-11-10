import express from "express";
import authenticate from "../../middleware/authenticate.js";
import authorize from "../../middleware/authorize.js";
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

// Categories
router.get("/categories", kbController.listCategories);
router.post("/categories", authorize("ADMIN", "AGENT"), kbController.createCategory);
router.patch("/categories/reorder", authorize("ADMIN", "AGENT"), kbController.reorderCategories);
router.patch("/categories/:id", authorize("ADMIN", "AGENT"), validateCategoryId, kbController.updateCategory);
router.delete("/categories/:id", authorize("ADMIN", "AGENT"), validateCategoryId, kbController.deleteCategory);

// Articles
router.get("/articles", kbController.listArticles);
router.get("/articles/export", kbController.exportArticlesCsv);
router.post("/articles", authorize("ADMIN", "AGENT"), kbController.createArticle);
router.get("/articles/:id", validateArticleIdentifier, kbController.getArticle);
router.patch("/articles/:id", authorize("ADMIN", "AGENT"), validateArticleIdentifier, kbController.updateArticle);
router.delete("/articles/:id", authorize("ADMIN", "AGENT"), validateArticleIdentifier, kbController.deleteArticle);
router.post("/articles/:id/publish", authorize("ADMIN", "AGENT"), validateArticleIdentifier, kbController.publishArticle);
router.post("/articles/:id/feedback", validateArticleIdentifier, kbController.voteFeedback);
router.get("/articles/:id/related", validateArticleIdentifier, kbController.getRelatedArticles);

// AI suggestion
router.post("/ai/suggest", authorize("ADMIN", "AGENT"), kbController.generateAiSuggestion);

export default router;

