import { describe, expect, it } from 'vitest';
import { InputValidationPipe } from '@/common/pipes/validation.pipe.js';
import { ListInvitationsQueryDto } from '../dto/list-invitations-query.dto.js';

describe('ListInvitationsQueryDto', () => {
  const validate = (value: Record<string, unknown>) =>
    new InputValidationPipe().transform(value, {
      type: 'query',
      metatype: ListInvitationsQueryDto,
    });

  it('normalizes email, status, and pagination values', async () => {
    await expect(
      validate({
        email: ' Member@Example.com ',
        status: 'pending',
        page: '2',
        limit: '10',
      }),
    ).resolves.toMatchObject({
      email: 'member@example.com',
      status: 'PENDING',
      page: 2,
      limit: 10,
    });
  });

  it.each([
    { status: 'unknown' },
    { email: 'not-an-email-address-that-is-too-long'.repeat(10) },
  ])('rejects invalid query input %j', async (value) => {
    await expect(validate(value)).rejects.toMatchObject({ status: 422 });
  });
});
