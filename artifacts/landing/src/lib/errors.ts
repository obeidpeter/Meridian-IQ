// The generated client throws ApiError carrying the parsed body; the server
// answers { error: string }.
export function serverErrorFrom(err: unknown): string | null {
  const data = (err as { data?: unknown })?.data;
  return data && typeof data === "object" && "error" in data
    ? String((data as { error: unknown }).error)
    : null;
}
