// The ApiError duck-typing lives in the workspace package so the apps
// classify rejections identically.
export { errorStatus, isFeatureDisabled } from "@workspace/api-errors";
