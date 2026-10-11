import type { Response } from "express";
import { z } from "zod";

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/** Success envelope: `{ data, meta? }`. Errors use `{ error: { code, message } }`. */
export function ok<T>(res: Response, data: T, meta?: object): void {
  res.status(200).json(meta ? { data, meta } : { data });
}

export function created<T>(res: Response, data: T): void {
  res.status(201).json({ data });
}

export function accepted<T>(res: Response, data: T): void {
  res.status(202).json({ data });
}

export function noContent(res: Response): void {
  res.status(204).end();
}

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type PaginationQuery = z.infer<typeof paginationQuery>;

export function paginate(query: PaginationQuery) {
  return { skip: (query.page - 1) * query.pageSize, limit: query.pageSize };
}

export function paginationMeta(query: PaginationQuery, total: number): PaginationMeta {
  return {
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

export const objectIdParam = z.string().regex(/^[a-f0-9]{24}$/i, "Invalid identifier.");
