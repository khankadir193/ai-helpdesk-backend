import express from "express";
import cors from "cors";
import helmet from "helmet";
import sessionMiddleware from "./config/session.js";
import env from "./config/env.js";
import ApiError from "./utils/ApiError.js";
import errorHandler from "./middleware/errorHandler.js";
import authRouter from "./modules/auth/auth.routes.js";
import categoryRouter from "./modules/categories/category.routes.js";

const app = express();

// ---------------------------------------------------------------------------
// Trust proxy
// Uncomment and set to the appropriate number of proxy hops if this server
// sits behind a reverse proxy (e.g. Nginx, AWS ALB, Railway, Render).
// Required for req.ip to reflect the real client IP with rate limiting.
// ---------------------------------------------------------------------------
// app.set("trust proxy", 1);

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
// Body parsers — cap at 100 kb to prevent request-body DoS
// ---------------------------------------------------------------------------
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "100kb" }));

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
    timestamp: new Date().toISOString(),
  });
});

v1Router.use("/auth", authRouter);
v1Router.use("/categories", categoryRouter);

app.use("/api/v1", v1Router);

// ---------------------------------------------------------------------------
// 404 and global error handler
// ---------------------------------------------------------------------------
app.use((_req, _res, next) => {
  next(new ApiError(404, "Route not found"));
});
app.use(errorHandler);

export default app;
