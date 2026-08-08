import type { Principal } from "../modules/auth/rbac";

declare global {
  namespace Express {
    interface Request {
      principal: Principal;
      abortSignal: AbortSignal;
      requestAbortController: AbortController;
    }
  }
}

export {};
