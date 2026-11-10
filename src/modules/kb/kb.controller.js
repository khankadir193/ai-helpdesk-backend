import asyncHandler from "../../utils/asyncHandler.js";
import kbService from "./kb.service.js";

export const kbController = {
  getOverview: asyncHandler(async (_req, res) => {
    const data = await kbService.getOverview();
    res.status(200).json({ status: "success", data });
  }),

  listArticles: asyncHandler(async (req, res) => {
    const { q, status, categoryId, authorId, sort, order, page, pageSize } = req.query;
    const data = await kbService.listArticles({
      q,
      status,
      categoryId,
      authorId,
      sort,
      order,
      page,
      pageSize,
    });
    res.status(200).json({ status: "success", data });
  }),

  exportArticlesCsv: asyncHandler(async (req, res) => {
    const { q, status, categoryId, authorId } = req.query;
    const csv = await kbService.exportCsv({ q, status, categoryId, authorId });
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="kb-articles.csv"');
    res.status(200).send(csv);
  }),

  getArticle: asyncHandler(async (req, res) => {
    const { id } = req.params;
    const clientIdentifier = req.user?.id || req.ip;
    const data = await kbService.getArticleByIdentifier(id, clientIdentifier);
    res.status(200).json({ status: "success", data });
  }),

  createArticle: asyncHandler(async (req, res) => {
    const author_id = req.user?.id;
    const data = await kbService.createArticle({ ...req.body, author_id });
    res.status(201).json({ status: "success", data });
  }),

  updateArticle: asyncHandler(async (req, res) => {
    const { id } = req.params;
    const data = await kbService.updateArticle(id, req.body);
    res.status(200).json({ status: "success", data });
  }),

  publishArticle: asyncHandler(async (req, res) => {
    const { id } = req.params;
    const publisherId = req.user?.id;
    const data = await kbService.publishArticle(id, publisherId);
    res.status(200).json({ status: "success", data });
  }),

  deleteArticle: asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await kbService.deleteArticle(id);
    res.status(200).json({ status: "success", data: result });
  }),

  voteFeedback: asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { helpful } = req.body;
    const clientIdentifier = req.user?.id ? `user-${req.user.id}` : `ip-${req.ip}`;
    const data = await kbService.voteFeedback(id, {
      helpful: Boolean(helpful),
      clientIdentifier,
      userId: req.user?.id,
    });
    res.status(200).json({ status: "success", data });
  }),

  getRelatedArticles: asyncHandler(async (req, res) => {
    const { id } = req.params;
    const data = await kbService.getRelatedArticles(id);
    res.status(200).json({ status: "success", data });
  }),

  listCategories: asyncHandler(async (_req, res) => {
    const data = await kbService.listCategories();
    res.status(200).json({ status: "success", data });
  }),

  createCategory: asyncHandler(async (req, res) => {
    const data = await kbService.createCategory(req.body);
    res.status(201).json({ status: "success", data });
  }),

  updateCategory: asyncHandler(async (req, res) => {
    const { id } = req.params;
    const data = await kbService.updateCategory(id, req.body);
    res.status(200).json({ status: "success", data });
  }),

  reorderCategories: asyncHandler(async (req, res) => {
    const { orderedIds } = req.body;
    const data = await kbService.reorderCategories(orderedIds);
    res.status(200).json({ status: "success", data });
  }),

  deleteCategory: asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await kbService.deleteCategory(id);
    res.status(200).json({ status: "success", data: result });
  }),

  listAuthors: asyncHandler(async (_req, res) => {
    const data = await kbService.listAuthors();
    res.status(200).json({ status: "success", data });
  }),

  generateAiSuggestion: asyncHandler(async (req, res) => {
    const data = await kbService.generateAiSuggestion(req.body);
    res.status(200).json({ status: "success", data });
  }),
};

export default kbController;

