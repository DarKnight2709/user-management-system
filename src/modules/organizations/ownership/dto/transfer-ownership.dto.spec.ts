import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { InputValidationPipe } from '@/common/pipes/validation.pipe.js';
import { TransferOwnershipDto } from './transfer-ownership.dto.js';

const validate = (value: unknown) =>
  new InputValidationPipe().transform(value, {
    type: 'body',
    metatype: TransferOwnershipDto,
  });

describe('Ownership transfer input', () => {
  it('accepts a target membership UUID', async () => {
    const memberId = randomUUID();
    await expect(validate({ memberId })).resolves.toMatchObject({ memberId });
  });
  it.each([
    {},
    { memberId: null },
    { memberId: 'bad' },
    { memberId: [] },
    { memberId: randomUUID(), ownerId: randomUUID() },
    { memberId: randomUUID(), actorId: randomUUID() },
  ])('rejects invalid or protected input %j', async (value) => {
    await expect(validate(value)).rejects.toMatchObject({ status: 422 });
  });
});
