import { describe, expect, it } from 'vitest';
import { InputValidationPipe } from '@/common/pipes/validation.pipe.js';
import { UpdateOrganizationDto } from './update-organization.dto.js';

const validate = (value: Record<string, unknown>) =>
  new InputValidationPipe().transform(value, {
    type: 'body',
    metatype: UpdateOrganizationDto,
  });

describe('Organization update validation', () => {
  it('trims a valid name', async () => {
    await expect(validate({ name: '  My Team  ' })).resolves.toMatchObject({
      name: 'My Team',
    });
  });
  it('accepts the maximum name length', async () => {
    await expect(validate({ name: 'a'.repeat(100) })).resolves.toMatchObject({
      name: 'a'.repeat(100),
    });
  });
  it.each([
    {},
    { name: '' },
    { name: '   ' },
    { name: null },
    { name: 123 },
    { name: true },
    { name: [] },
    { name: {} },
    { name: 'a'.repeat(101) },
  ])('rejects invalid name input %j', async (body) => {
    await expect(validate(body)).rejects.toMatchObject({ status: 422 });
  });
  it.each(['ownerId', 'slug', 'isActive', 'deletedAt', 'roles', 'members'])(
    'rejects protected field %s',
    async (field) => {
      await expect(
        validate({ name: 'Allowed name', [field]: 'forbidden' }),
      ).rejects.toMatchObject({ status: 422 });
    },
  );
});
