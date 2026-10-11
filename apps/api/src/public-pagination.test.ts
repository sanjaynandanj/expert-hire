import { describe, expect, it } from "vitest";
import { afterPublicCursor, publicPage, publicPaginationSchema } from "./public-pagination";

describe("public API pagination", () => {
  it("defaults and bounds page sizes", () => {
    expect(publicPaginationSchema.parse({})).toEqual({ limit: 100 });
    expect(publicPaginationSchema.parse({ limit: "2", cursor: "record-id" })).toEqual({ limit: 2, cursor: "record-id" });
    for (const limit of ["", "0", "101", "1.5", "NaN", ["1", "2"]]) expect(publicPaginationSchema.safeParse({ limit }).success).toBe(false);
    expect(publicPaginationSchema.safeParse({ cursor: "" }).success).toBe(false);
  });

  it("seeks by immutable timestamp and unique ID rather than offset", () => {
    const createdAt = new Date("2026-10-07T00:00:00.000Z");
    expect(afterPublicCursor({ id: "b", createdAt })).toEqual({ OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: "b" } }] });
    expect(afterPublicCursor(null)).toEqual({});
  });

  it("uses one extra row to expose a continuation cursor and the scoped total", () => {
    expect(publicPage([{ id: "c" }, { id: "b" }, { id: "a" }], 2, 7)).toEqual({ object: "list", data: [{ id: "c" }, { id: "b" }], has_more: true, next_cursor: "b", total_count: 7 });
    expect(publicPage([{ id: "a" }], 2, 7)).toMatchObject({ has_more: false, next_cursor: null, total_count: 7 });
    expect(publicPage([], 2, 0)).toMatchObject({ data: [], has_more: false, next_cursor: null, total_count: 0 });
  });
});
