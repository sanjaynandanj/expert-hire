import { z } from "zod";

export const publicPaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  cursor: z.string().min(1).max(100).optional()
});

/** The cursor row must first be resolved inside the endpoint's tenant/visibility scope. */
export function afterPublicCursor(cursor: { id: string; createdAt: Date } | null) {
  return cursor ? { OR: [
    { createdAt: { lt: cursor.createdAt } },
    { createdAt: cursor.createdAt, id: { lt: cursor.id } }
  ] } : {};
}

export function publicPage<T extends { id: string }>(rows: T[], limit: number, total: number) {
  const data = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  return { object: "list", data, has_more: hasMore, next_cursor: hasMore ? data.at(-1)!.id : null, total_count: total };
}
