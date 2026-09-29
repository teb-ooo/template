/** One plain sentence fragment for any error a query or mutation can hold (ApiError, network failure, or schema type). */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const { detail, title } = error as { detail?: unknown; title?: unknown };
    if (typeof detail === "string" && detail !== "") return detail;
    if (typeof title === "string" && title !== "") return title;
  }
  return "Please try again.";
}
