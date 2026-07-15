// The ApiError duck-typing and the Clerk gateway status policy live in the
// workspace package so the apps classify rejections identically; the console
// relays the server's words as-is (fallbacks are per-toast).
export {
  errorStatus,
  isFeatureDisabled,
  isForbidden,
  killSwitchTripped,
  serverError as serverErrorMessage,
} from "@workspace/api-errors";
