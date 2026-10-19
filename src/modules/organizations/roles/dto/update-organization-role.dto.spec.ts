import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { InputValidationPipe } from '@/common/pipes/validation.pipe.js';
import { UpdateOrganizationRoleDto } from './update-organization-role.dto.js';

const validate = (value: unknown) =>
  new InputValidationPipe().transform(value, {
    type: 'body',
    metatype: UpdateOrganizationRoleDto,
  });

describe('Update organization role input', () => {
  it('accepts a name-only update and normalizes it', async () => {
    await expect(validate({ name: ' moderator ' })).resolves.toMatchObject({
      name: 'MODERATOR',
    });
  });
  it('allows clearing all permissions without supplying a name', async () => {
    await expect(validate({ permissionIds: [] })).resolves.toMatchObject({
      permissionIds: [],
    });
  });
  it.each([
    { name: null },
    { permissionIds: null },
    { name: 'admin' },
    { name: 'bad name' },
    { permissionIds: ['invalid'] },
    { organizationId: randomUUID() },
    { isSystem: true },
  ])('rejects malformed or protected input %j', async (value) => {
    await expect(validate(value)).rejects.toMatchObject({ status: 422 });
  });
});
