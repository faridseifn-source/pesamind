const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const cookieParser = require("cookie-parser");
const { ZodError } = require("zod");
const env = require("./lib/env");
const { notFoundHandler, errorHandler } = require("./middleware/errorHandler");

const authRoutes = require("./modules/auth/auth.routes");
const usersRoutes = require("./modules/users/users.routes");
const categoriesRoutes = require("./modules/categories/categories.routes");
const budgetsRoutes = require("./modules/budgets/budgets.routes");
const transactionsRoutes = require("./modules/transactions/transactions.routes");
const walletsRoutes = require("./modules/wallets/wallets.routes");
const cardsRoutes = require("./modules/cards/cards.routes");
const kycRoutes = require("./modules/kyc/kyc.routes");
const notificationsRoutes = require("./modules/notifications/notifications.routes");
const adminRoutes = require("./modules/admin/admin.routes");

const app = express();

app.use(helmet());
app.use(cors({ origin: env.corsOrigin, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: "2mb" }));
if (env.nodeEnv !== "test") app.use(morgan(env.nodeEnv === "production" ? "combined" : "dev"));

app.get("/health", (req, res) => res.json({ ok: true, env: env.nodeEnv }));

app.use("/auth", authRoutes);
app.use("/users", usersRoutes);
app.use("/categories", categoriesRoutes);
app.use("/budgets", budgetsRoutes);
app.use("/transactions", transactionsRoutes);
app.use("/wallets", walletsRoutes);
app.use("/cards", cardsRoutes);
app.use("/kyc", kycRoutes);
app.use("/notifications", notificationsRoutes);
app.use("/admin", adminRoutes);

app.use(notFoundHandler);

// Turn Zod validation failures into clean 400s before they hit the generic handler.
app.use((err, req, res, next) => {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: "Invalid request", details: err.issues });
  }
  next(err);
});
app.use(errorHandler);

module.exports = app;
