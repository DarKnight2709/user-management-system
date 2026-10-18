import { UnprocessableEntityException } from '@nestjs/common';

// Service-level validation also protects calls that bypass controller DTOs.
export function assertValidPagination(page: number, limit: number): void {
  if (
    !Number.isInteger(page) ||
    page < 1 ||
    page > 1_000_000 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    throw new UnprocessableEntityException('Invalid pagination');
  }
}
