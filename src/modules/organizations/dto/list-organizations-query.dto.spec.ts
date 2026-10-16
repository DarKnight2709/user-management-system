import { describe, expect, it } from 'vitest';
import { InputValidationPipe } from '@/common/pipes/validation.pipe.js';
import { ListOrganizationsQueryDto } from './list-organizations-query.dto.js';

const validate = (value: Record<string, unknown>) =>
  new InputValidationPipe().transform(value, {
    type: 'query',
    metatype: ListOrganizationsQueryDto,
  });

describe('Organization-list query validation', () => {
  it('defaults to page 1 and limit 20', async () => {
    await expect(validate({})).resolves.toMatchObject({ page: 1, limit: 20 });
  });
  it('converts numeric query strings and accepts upper bounds', async () => {
    await expect(
      validate({ page: '1000000', limit: '100' }),
    ).resolves.toMatchObject({ page: 1_000_000, limit: 100 });
  });
  it.each([
    { page: '0' },
    { page: '-1' },
    { page: '1.5' },
    { page: '1000001' },
    { page: 'nope' },
    { page: ['1', '2'] },
    { limit: '0' },
    { limit: '101' },
    { limit: '2.5' },
    { limit: '' },
    { actorId: 'spoofed' },
  ])('rejects invalid or unexpected query %j', async (query) => {
    await expect(validate(query)).rejects.toMatchObject({ status: 422 });
  });
});
