import express from "express";
import cors from "cors";
import helmet from "helmet";
import sessionMiddleware from "./config/session.js";
import env from "./config/env.js";
import ApiError from "./utils/ApiError.js";
import errorHandler from "./middleware/errorHandler.js";
import authRouter from "./modules/auth/auth.routes.js";
import categoryRouter from "./modules/categories/category.routes.js";
import ticketRouter from "./modules/tickets/ticket.routes.js";
import commentRouter from "./modules/comments/comment.routes.js";
import aiRouter from "./modules/ai/ai.routes.js";
import dashboardRouter from "./modules/dashboard/dashboard.routes.js";
import reportsRouter from "./modules/reports/reports.routes.js";
import userRouter from "./modules/users/user.routes.js";
import kbRouter from "./modules/kb/kb.routes.js";
import settingsRouter from "./modules/settings/settings.routes.js";

const app = express();

// ---------------------------------------------------------------------------
// Trust proxy
// Sits behind a reverse proxy (e.g. Vite dev proxy, Nginx, AWS ALB, Railway, Render).
// Required for req.ip to reflect the real client IP with rate limiting.
// ---------------------------------------------------------------------------
app.set("trust proxy", 1);

// ---------------------------------------------------------------------------
// Security headers (helmet sets sensible defaults)
// ---------------------------------------------------------------------------
app.disable("x-powered-by");
app.use(helmet());

// ---------------------------------------------------------------------------
// CORS
// In development, allow all origins with credentials disabled (no cookies
// cross-origin during local testing).
// In production, restrict to the known frontend origin and enable credentials
// so the session cookie is forwarded on cross-origin requests.
//
// IMPORTANT: When sameSite:"none" is used for cross-origin cookies, ensure
// secure:true is also set in session.js and the request is over HTTPS.
// ---------------------------------------------------------------------------
const corsOptions = env.isProduction
  ? {
      origin: process.env.FRONTEND_ORIGIN || false,
      credentials: true,
      methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type"],
    }
  : {
      // Development: allow the typical Vite/CRA dev-server origins.
      // Adjust this list to match your local setup.
      origin: [
        "http://localhost:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
      ],
      credentials: true,
      methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type"],
    };

app.use(cors(corsOptions));

// ---------------------------------------------------------------------------
// Body parsers — 10mb to allow image avatar uploads
// ---------------------------------------------------------------------------
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: false, limit: "10mb" }));

// ---------------------------------------------------------------------------
// Session middleware
// Must be registered BEFORE any route that reads or writes req.session.
// ---------------------------------------------------------------------------
app.use(sessionMiddleware);

// ---------------------------------------------------------------------------
// API v1 routes
// ---------------------------------------------------------------------------
const v1Router = express.Router();

v1Router.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    message: "AI Help Desk API is running successfully!",
    timestamp: new Date().toISOString(),
  });
});

v1Router.use("/auth", authRouter);
v1Router.use("/categories", categoryRouter);
v1Router.use("/tickets", ticketRouter);
v1Router.use("/tickets", commentRouter);
v1Router.use("/tickets", aiRouter);
v1Router.use("/dashboard", dashboardRouter);
v1Router.use("/reports", reportsRouter);
v1Router.use("/users", userRouter);
v1Router.use("/kb", kbRouter);
v1Router.use("/settings", settingsRouter);

app.use("/api/v1", v1Router);

// ---------------------------------------------------------------------------
// 404 and global error handler
// ---------------------------------------------------------------------------
app.use((_req, _res, next) => {
  next(new ApiError(404, "Route not found"));
});
app.use(errorHandler);

export default app;
