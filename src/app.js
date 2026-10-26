import express from "express";
import ApiError from "./utils/ApiError.js";
import errorHandler from "./middleware/errorHandler.js";
import authRouter from "./modules/auth/auth.routes.js";
import categoryRouter from "./modules/categories/category.routes.js";

const app = express();

app.disable("x-powered-by");
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const v1Router = express.Router();
v1Router.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

v1Router.use("/auth", authRouter);
v1Router.use("/categories", categoryRouter);

app.use("/api/v1", v1Router);
app.use((_req, _res, next) => {
  next(new ApiError(404, "Route not found"));
});
app.use(errorHandler);

export default app;
