import { describe, expect, it } from 'vitest';
import { InputValidationPipe } from '@/common/pipes/validation.pipe.js';
import { ListOrganizationMembersQueryDto } from './list-organization-members-query.dto.js';

const validate = (value: Record<string, unknown>) =>
  new InputValidationPipe().transform(value, {
    type: 'query',
    metatype: ListOrganizationMembersQueryDto,
  });

describe('Member-directory query validation', () => {
  it('inherits pagination defaults', async () => {
    await expect(validate({})).resolves.toMatchObject({ page: 1, limit: 20 });
  });
  it('converts numeric strings and accepts upper bounds', async () => {
    await expect(
      validate({ page: '1000000', limit: '100' }),
    ).resolves.toMatchObject({ page: 1_000_000, limit: 100 });
  });
  it.each([
    { page: '0' },
    { page: '1.5' },
    { page: '1000001' },
    { page: ['1', '2'] },
    { limit: '0' },
    { limit: '101' },
    { limit: 'nope' },
    { status: 'SUSPENDED' },
    { organizationId: 'spoofed' },
    { actorId: 'spoofed' },
  ])('rejects invalid or unexpected query %j', async (query) => {
    await expect(validate(query)).rejects.toMatchObject({ status: 422 });
  });
});
