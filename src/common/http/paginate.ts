/** Laravel's paginator: `?page` must be an integer ≥ 1, else page 1. */
export function pageFrom(raw: unknown): number {
  return typeof raw === 'string' && /^[+]?\d+$/.test(raw) && Number(raw) >= 1
    ? Number(raw)
    : 1;
}

/** LengthAwarePaginator meta. */
export function pageMeta(page: number, perPage: number, total: number) {
  return {
    current_page: page,
    per_page: perPage,
    total,
    last_page: Math.max(1, Math.ceil(total / perPage)),
  };
}
