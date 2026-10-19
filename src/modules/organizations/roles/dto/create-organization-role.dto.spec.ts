import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { InputValidationPipe } from '@/common/pipes/validation.pipe.js';
import { CreateOrganizationRoleDto } from './create-organization-role.dto.js';

const validate = (value: unknown) =>
  new InputValidationPipe().transform(value, {
    type: 'body',
    metatype: CreateOrganizationRoleDto,
  });

describe('Create organization role input', () => {
  it('normalizes a role name and permits an empty permission selection', async () => {
    await expect(
      validate({ name: ' moderator ', permissionIds: [] }),
    ).resolves.toMatchObject({ name: 'MODERATOR', permissionIds: [] });
  });
  it.each([
    { name: 'admin', permissionIds: [] },
    { name: ' OWNER ', permissionIds: [] },
    { name: 'member', permissionIds: [] },
    { name: '', permissionIds: [] },
    { name: 'a'.repeat(51), permissionIds: [] },
    { name: 'role name', permissionIds: [] },
    { name: '123', permissionIds: [] },
    { name: 'VALID' },
    { name: 'VALID', permissionIds: ['invalid'] },
    { name: 'VALID', permissionIds: Array(12).fill(randomUUID()) },
    { name: 'VALID', permissionIds: [], isSystem: true },
    { name: 'VALID', permissionIds: [], organizationId: randomUUID() },
  ])('rejects invalid or protected input %j', async (value) => {
    await expect(validate(value)).rejects.toMatchObject({ status: 422 });
  });
  it('rejects duplicate permission IDs', async () => {
    const id = randomUUID();
    await expect(
      validate({ name: 'VALID', permissionIds: [id, id] }),
    ).rejects.toMatchObject({ status: 422 });
  });
});
