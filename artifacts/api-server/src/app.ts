import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import router from "./routes";
import { logger } from "./lib/logger";
import { resolvePrincipal } from "./middleware/principal";
import { errorHandler } from "./middleware/error";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Verify the Clerk session (if any) from cookie/Bearer token and attach auth to
// the request. resolvePrincipal reads getAuth(req) to build the tenant-scoped
// principal in production; the dev-header shim is used only outside production.
app.use(clerkMiddleware());
app.use(resolvePrincipal);
app.use("/api", router);

app.use(errorHandler);

export default app;
