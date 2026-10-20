const express = require("express");
const ApiError = require("./utils/ApiError");
const errorHandler = require("./middleware/errorHandler");

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

app.use("/api/v1", v1Router);
app.use((_req, _res, next) => {
  next(new ApiError(404, "Route not found"));
});
app.use(errorHandler);

module.exports = app;
