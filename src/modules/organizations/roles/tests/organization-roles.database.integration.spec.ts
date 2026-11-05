import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client.js';
import type { PrismaService } from '@/core/database/prisma.service.js';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { organizationPermissions } from '@/common/constants/organization-permissions.constant.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import {
  clearOrganizationTables,
  createFixtureUser,
  createIsolatedDatabase,
  type IsolatedDatabase,
} from '../../../../../test/support/isolated-database.js';
import { OrganizationRoleManagementService } from '../organization-role-management.service.js';
import { OrganizationRolesService } from '../organization-roles.service.js';
import { RoleAuthorityService } from '../role-authority.service.js';
import type { ListOrganizationRolesQueryDto } from '../dto/list-organization-roles-query.dto.js';

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === 'true';

const listQuery = (
  overrides: Partial<ListOrganizationRolesQueryDto> = {},
): ListOrganizationRolesQueryDto =>
  ({ page: 1, limit: 20, ...overrides }) as ListOrganizationRolesQueryDto;

describe.runIf(runDatabaseTests)(
  'Organization roles database integration',
  () => {
    let database: IsolatedDatabase;
    let db: PrismaClient;
    let ownerId: string;
    let delegateId: string;
    let outsiderId: string;
    let organizationId: string;
    let otherOrganizationId: string;
    let permissionIds: Record<string, string>;
    let logging: {
      audit: ReturnType<typeof vi.fn>;
      publishCommittedAudit: ReturnType<typeof vi.fn>;
    };
    let management: OrganizationRoleManagementService;
    let reader: OrganizationRolesService;

    const permissionKey = (resource: string, action: string) =>
      `${resource}:${action}`;
    const permissionId = (resource: string, action: string) =>
      permissionIds[permissionKey(resource, action)];

    const createOrganization = async (ownerUserId: string, label: string) => {
      const organization = await db.organization.create({
        data: {
          name: label,
          slug: `${label}-${randomUUID()}`,
          ownerId: ownerUserId,
        },
      });
      await db.organizationMember.create({
        data: { organizationId: organization.id, userId: ownerUserId },
      });
      return organization.id;
    };

    /** Grants the delegate a custom role in the organization holding the listed permissions. */
    const grantDelegateRole = async (
      name: string,
      grants: [resource: string, action: string][],
    ) => {
      const membership = await db.organizationMember.create({
        data: { organizationId, userId: delegateId },
      });
      const role = await db.role.create({
        data: {
          organizationId,
          name,
          isSystem: false,
          rolePermissions: {
            create: grants.map(([resource, action]) => ({
              permissionId: permissionId(resource, action),
            })),
          },
        },
      });
      await db.memberRole.create({
        data: { organizationMemberId: membership.id, roleId: role.id },
      });
      return role.id;
    };

    const createCustomRole = (
      name: string,
      grants: [resource: string, action: string][],
      scopeOrganizationId = organizationId,
    ) =>
      db.role.create({
        data: {
          organizationId: scopeOrganizationId,
          name,
          isSystem: false,
          rolePermissions: {
            create: grants.map(([resource, action]) => ({
              permissionId: permissionId(resource, action),
            })),
          },
        },
      });

    const activeGrantKeys = async (roleId: string) => {
      const grants = await db.rolePermission.findMany({
        where: { roleId, deletedAt: null },
        include: { permission: true },
      });
      return grants
        .map(({ permission }) =>
          permissionKey(permission.resource, permission.action),
        )
        .sort();
    };

    beforeAll(async () => {
      database = await createIsolatedDatabase('organization_roles');
      db = database.db;
    }, 30_000);

    beforeEach(async () => {
      await clearOrganizationTables(db);
      const created = await db.permission.createManyAndReturn({
        data: organizationPermissions.map(
          ({ resource, action, description }) => ({
            resource,
            action,
            description,
          }),
        ),
      });
      permissionIds = Object.fromEntries(
        created.map(({ id, resource, action }) => [
          permissionKey(resource, action),
          id,
        ]),
      );

      ownerId = (await createFixtureUser(db, 'owner')).id;
      delegateId = (await createFixtureUser(db, 'delegate')).id;
      outsiderId = (await createFixtureUser(db, 'outsider')).id;
      organizationId = await createOrganization(ownerId, 'roles-primary');
      otherOrganizationId = await createOrganization(
        ownerId,
        'roles-secondary',
      );

      logging = {
        audit: vi.fn().mockResolvedValue({ eventId: randomUUID() }),
        publishCommittedAudit: vi.fn(),
      };
      const permissions = new PermissionsService(
        database.prisma as PrismaService,
      );
      const authority = new RoleAuthorityService(permissions);
      management = new OrganizationRoleManagementService(
        database.prisma,
        authority,
        logging as unknown as LoggingService,
      );
      reader = new OrganizationRolesService(
        database.prisma,
        permissions,
        authority,
      );
    });

    afterAll(async () => {
      await database?.dispose();
    });

    describe('create', () => {
      it('persists the role with its active grants', async () => {
        const created = await management.createForActor(
          ownerId,
          organizationId,
          {
            name: 'reviewer',
            permissionIds: [
              permissionId('ORGANIZATION', 'read'),
              permissionId('ORGANIZATION_MEMBER', 'read'),
            ],
          },
        );

        const stored = await db.role.findUniqueOrThrow({
          where: { id: created.id },
        });
        expect(stored).toMatchObject({
          name: 'REVIEWER',
          organizationId,
          isSystem: false,
          deletedAt: null,
        });
        await expect(activeGrantKeys(created.id)).resolves.toEqual([
          'ORGANIZATION:read',
          'ORGANIZATION_MEMBER:read',
        ]);
      });

      it('publishes the audit event once, after commit', async () => {
        await management.createForActor(ownerId, organizationId, {
          name: 'reviewer',
          permissionIds: [],
        });

        expect(logging.audit).toHaveBeenCalledOnce();
        expect(logging.publishCommittedAudit).toHaveBeenCalledOnce();
      });

      it('reserves names case-insensitively, including deleted roles', async () => {
        const existing = await createCustomRole('REVIEWER', []);
        await db.role.update({
          where: { id: existing.id },
          data: { deletedAt: new Date() },
        });

        await expect(
          management.createForActor(ownerId, organizationId, {
            name: 'reviewer',
            permissionIds: [],
          }),
        ).rejects.toMatchObject({ status: 409 });
      });

      it('allows the same name in a different organization', async () => {
        await createCustomRole('REVIEWER', [], otherOrganizationId);

        await expect(
          management.createForActor(ownerId, organizationId, {
            name: 'reviewer',
            permissionIds: [],
          }),
        ).resolves.toMatchObject({ name: 'REVIEWER' });
      });

      it('rejects the audit permission and unknown IDs without writing', async () => {
        await expect(
          management.createForActor(ownerId, organizationId, {
            name: 'auditor',
            permissionIds: [permissionId('ORGANIZATION_AUDIT_LOG', 'read')],
          }),
        ).rejects.toMatchObject({ status: 422 });
        await expect(
          management.createForActor(ownerId, organizationId, {
            name: 'ghost',
            permissionIds: [randomUUID()],
          }),
        ).rejects.toMatchObject({ status: 422 });
        await expect(
          db.role.count({ where: { organizationId } }),
        ).resolves.toBe(0);
      });

      it('rejects permissions that were soft-deleted from the catalog', async () => {
        await db.permission.update({
          where: { id: permissionId('ORGANIZATION', 'read') },
          data: { deletedAt: new Date() },
        });

        await expect(
          management.createForActor(ownerId, organizationId, {
            name: 'reviewer',
            permissionIds: [permissionId('ORGANIZATION', 'read')],
          }),
        ).rejects.toMatchObject({ status: 422 });
      });

      it('lets a delegate grant only permissions they hold', async () => {
        await grantDelegateRole('ROLE_MANAGER', [
          ['ORGANIZATION_ROLE', 'create'],
          ['ORGANIZATION_ROLE', 'read'],
          ['ORGANIZATION', 'read'],
        ]);

        await expect(
          management.createForActor(delegateId, organizationId, {
            name: 'viewer',
            permissionIds: [permissionId('ORGANIZATION', 'read')],
          }),
        ).resolves.toMatchObject({ name: 'VIEWER' });
        await expect(
          management.createForActor(delegateId, organizationId, {
            name: 'inviter',
            permissionIds: [permissionId('ORGANIZATION_MEMBER', 'invite')],
          }),
        ).rejects.toMatchObject({ status: 403 });
      });

      it('rejects members without create permission, outsiders and deleted users', async () => {
        await grantDelegateRole('READER', [['ORGANIZATION_ROLE', 'read']]);
        const deletedUser = await createFixtureUser(db, 'deleted');
        await db.user.update({
          where: { id: deletedUser.id },
          data: { deletedAt: new Date() },
        });
        const dto = { name: 'reviewer', permissionIds: [] };

        await expect(
          management.createForActor(delegateId, organizationId, dto),
        ).rejects.toMatchObject({ status: 403 });
        await expect(
          management.createForActor(outsiderId, organizationId, dto),
        ).rejects.toMatchObject({ status: 403 });
        await expect(
          management.createForActor(deletedUser.id, organizationId, dto),
        ).rejects.toMatchObject({ status: 401 });
      });

      it('does not let the owner of one organization manage another', async () => {
        const foreignOwnerId = (await createFixtureUser(db, 'foreign')).id;
        await createOrganization(foreignOwnerId, 'foreign-org');

        await expect(
          management.createForActor(foreignOwnerId, organizationId, {
            name: 'intruder',
            permissionIds: [],
          }),
        ).rejects.toMatchObject({ status: 403 });
      });
    });

    describe('update', () => {
      it('renames a role and keeps its grants', async () => {
        const role = await createCustomRole('EDITOR', [
          ['ORGANIZATION', 'read'],
        ]);

        await management.updateForActor(
          { actorId: ownerId, organizationId, roleId: role.id },
          { name: 'writers' },
        );

        await expect(
          db.role.findUniqueOrThrow({ where: { id: role.id } }),
        ).resolves.toMatchObject({ name: 'WRITERS' });
        await expect(activeGrantKeys(role.id)).resolves.toEqual([
          'ORGANIZATION:read',
        ]);
      });

      it('soft-revokes removed grants and restores them on a later update', async () => {
        const role = await createCustomRole('EDITOR', [
          ['ORGANIZATION', 'read'],
          ['ORGANIZATION_MEMBER', 'read'],
        ]);
        const target = { actorId: ownerId, organizationId, roleId: role.id };

        await management.updateForActor(target, {
          permissionIds: [permissionId('ORGANIZATION', 'read')],
        });
        const revoked = await db.rolePermission.findUniqueOrThrow({
          where: {
            roleId_permissionId: {
              roleId: role.id,
              permissionId: permissionId('ORGANIZATION_MEMBER', 'read'),
            },
          },
        });
        expect(revoked.deletedAt).not.toBeNull();

        await management.updateForActor(target, {
          permissionIds: [
            permissionId('ORGANIZATION', 'read'),
            permissionId('ORGANIZATION_MEMBER', 'read'),
          ],
        });
        await expect(activeGrantKeys(role.id)).resolves.toEqual([
          'ORGANIZATION:read',
          'ORGANIZATION_MEMBER:read',
        ]);
        await expect(
          db.rolePermission.count({ where: { roleId: role.id } }),
        ).resolves.toBe(2);
      });

      it('clears every grant with an empty list while retaining assignments', async () => {
        const role = await createCustomRole('EDITOR', [
          ['ORGANIZATION', 'read'],
        ]);
        const membership = await db.organizationMember.create({
          data: { organizationId, userId: delegateId },
        });
        await db.memberRole.create({
          data: { organizationMemberId: membership.id, roleId: role.id },
        });

        await management.updateForActor(
          { actorId: ownerId, organizationId, roleId: role.id },
          { permissionIds: [] },
        );

        await expect(activeGrantKeys(role.id)).resolves.toEqual([]);
        await expect(
          db.memberRole.count({
            where: { roleId: role.id, deletedAt: null },
          }),
        ).resolves.toBe(1);
      });

      it('rejects renaming onto another role name', async () => {
        const role = await createCustomRole('EDITOR', []);
        await createCustomRole('WRITERS', []);

        await expect(
          management.updateForActor(
            { actorId: ownerId, organizationId, roleId: role.id },
            { name: 'writers' },
          ),
        ).rejects.toMatchObject({ status: 409 });
      });

      it('refuses to modify built-in roles', async () => {
        const admin = await createCustomRole('ADMIN', []);

        await expect(
          management.updateForActor(
            { actorId: ownerId, organizationId, roleId: admin.id },
            { name: 'bosses' },
          ),
        ).rejects.toMatchObject({ status: 403 });
      });

      it('does not find roles from another organization', async () => {
        const foreign = await createCustomRole(
          'EDITOR',
          [],
          otherOrganizationId,
        );

        await expect(
          management.updateForActor(
            { actorId: ownerId, organizationId, roleId: foreign.id },
            { name: 'writers' },
          ),
        ).rejects.toMatchObject({ status: 404 });
        await expect(
          db.role.findUniqueOrThrow({ where: { id: foreign.id } }),
        ).resolves.toMatchObject({ name: 'EDITOR' });
      });

      it('requires non-owners to hold the existing grants of the role', async () => {
        await grantDelegateRole('ROLE_MANAGER', [
          ['ORGANIZATION_ROLE', 'update'],
          ['ORGANIZATION_ROLE', 'read'],
        ]);
        const role = await createCustomRole('EDITOR', [
          ['ORGANIZATION_MEMBER', 'invite'],
        ]);

        await expect(
          management.updateForActor(
            { actorId: delegateId, organizationId, roleId: role.id },
            { name: 'writers' },
          ),
        ).rejects.toMatchObject({ status: 403 });
      });

      it('applies concurrent replacements without merging them', async () => {
        const role = await createCustomRole('EDITOR', []);
        const target = { actorId: ownerId, organizationId, roleId: role.id };
        const first = [permissionId('ORGANIZATION', 'read')];
        const second = [permissionId('ORGANIZATION_MEMBER', 'read')];

        await Promise.all([
          management.updateForActor(target, { permissionIds: first }),
          management.updateForActor(target, { permissionIds: second }),
        ]);

        const finalKeys = await activeGrantKeys(role.id);
        expect([
          ['ORGANIZATION:read'],
          ['ORGANIZATION_MEMBER:read'],
        ]).toContainEqual(finalKeys);
      });
    });

    describe('delete', () => {
      it('soft-deletes the role and retains grants and assignments', async () => {
        const role = await createCustomRole('EDITOR', [
          ['ORGANIZATION', 'read'],
        ]);
        const membership = await db.organizationMember.create({
          data: { organizationId, userId: delegateId },
        });
        await db.memberRole.create({
          data: { organizationMemberId: membership.id, roleId: role.id },
        });

        await management.deleteForActor({
          actorId: ownerId,
          organizationId,
          roleId: role.id,
        });

        const stored = await db.role.findUniqueOrThrow({
          where: { id: role.id },
        });
        expect(stored.deletedAt).not.toBeNull();
        await expect(activeGrantKeys(role.id)).resolves.toEqual([
          'ORGANIZATION:read',
        ]);
        await expect(
          db.memberRole.count({ where: { roleId: role.id, deletedAt: null } }),
        ).resolves.toBe(1);
      });

      it('keeps the original deletion time on a repeated request', async () => {
        const role = await createCustomRole('EDITOR', []);
        const target = { actorId: ownerId, organizationId, roleId: role.id };

        await management.deleteForActor(target);
        const first = await db.role.findUniqueOrThrow({
          where: { id: role.id },
        });
        await management.deleteForActor(target);
        const second = await db.role.findUniqueOrThrow({
          where: { id: role.id },
        });

        expect(second.deletedAt).toEqual(first.deletedAt);
        expect(logging.publishCommittedAudit).toHaveBeenCalledOnce();
      });

      it('does not delete roles from another organization', async () => {
        const foreign = await createCustomRole(
          'EDITOR',
          [],
          otherOrganizationId,
        );

        await expect(
          management.deleteForActor({
            actorId: ownerId,
            organizationId,
            roleId: foreign.id,
          }),
        ).rejects.toMatchObject({ status: 404 });
        await expect(
          db.role.findUniqueOrThrow({ where: { id: foreign.id } }),
        ).resolves.toMatchObject({ deletedAt: null });
      });

      it('refuses to delete built-in roles', async () => {
        const member = await createCustomRole('MEMBER', []);

        await expect(
          management.deleteForActor({
            actorId: ownerId,
            organizationId,
            roleId: member.id,
          }),
        ).rejects.toMatchObject({ status: 403 });
      });

      it('denies actors without the delete permission', async () => {
        await grantDelegateRole('READER', [['ORGANIZATION_ROLE', 'read']]);
        const role = await createCustomRole('EDITOR', []);

        await expect(
          management.deleteForActor({
            actorId: delegateId,
            organizationId,
            roleId: role.id,
          }),
        ).rejects.toMatchObject({ status: 403 });
      });

      it('does not restore a role that was deleted before an update ran', async () => {
        const role = await createCustomRole('EDITOR', []);
        const target = { actorId: ownerId, organizationId, roleId: role.id };

        await management.deleteForActor(target);

        await expect(
          management.updateForActor(target, { name: 'writers' }),
        ).rejects.toMatchObject({ status: 404 });
        await expect(
          db.role.findUniqueOrThrow({ where: { id: role.id } }),
        ).resolves.toMatchObject({ name: 'EDITOR' });
      });
    });

    describe('list', () => {
      it('returns only active roles of the requested organization', async () => {
        await createCustomRole('EDITOR', []);
        await createCustomRole('ADMIN', []);
        await createCustomRole('OWNER', []);
        const deleted = await createCustomRole('RETIRED', []);
        await db.role.update({
          where: { id: deleted.id },
          data: { deletedAt: new Date() },
        });
        await createCustomRole('FOREIGN', [], otherOrganizationId);

        const page = await reader.listForActor(
          ownerId,
          organizationId,
          listQuery(),
        );

        expect(page.items.map(({ name }) => name)).toEqual(['ADMIN', 'EDITOR']);
        expect(page.total).toBe(2);
      });

      it('marks built-in roles and filters by type', async () => {
        await createCustomRole('EDITOR', []);
        await createCustomRole('ADMIN', []);

        const builtIn = await reader.listForActor(
          ownerId,
          organizationId,
          listQuery({ type: 'BUILT_IN' }),
        );
        const custom = await reader.listForActor(
          ownerId,
          organizationId,
          listQuery({ type: 'CUSTOM' }),
        );

        expect(builtIn.items.map(({ name }) => name)).toEqual(['ADMIN']);
        expect(builtIn.items[0].isBuiltIn).toBe(true);
        expect(custom.items.map(({ name }) => name)).toEqual(['EDITOR']);
      });

      it('searches names and filters by granted permission', async () => {
        await createCustomRole('EDITOR', [['ORGANIZATION', 'read']]);
        await createCustomRole('VIEWER', [['ORGANIZATION_MEMBER', 'read']]);

        const byName = await reader.listForActor(
          ownerId,
          organizationId,
          listQuery({ search: 'edit' }),
        );
        const byPermission = await reader.listForActor(
          ownerId,
          organizationId,
          listQuery({
            permissionId: permissionId('ORGANIZATION_MEMBER', 'read'),
          }),
        );

        expect(byName.items.map(({ name }) => name)).toEqual(['EDITOR']);
        expect(byPermission.items.map(({ name }) => name)).toEqual(['VIEWER']);
      });

      it('hides revoked grants and paginates with a stable total', async () => {
        const role = await createCustomRole('EDITOR', [
          ['ORGANIZATION', 'read'],
        ]);
        await createCustomRole('WRITER', []);
        await db.rolePermission.updateMany({
          where: { roleId: role.id },
          data: { deletedAt: new Date() },
        });

        const firstPage = await reader.listForActor(
          ownerId,
          organizationId,
          listQuery({ limit: 1 }),
        );
        const secondPage = await reader.listForActor(
          ownerId,
          organizationId,
          listQuery({ page: 2, limit: 1 }),
        );

        expect(firstPage.items[0]).toMatchObject({
          name: 'EDITOR',
          permissions: [],
        });
        expect(secondPage.items.map(({ name }) => name)).toEqual(['WRITER']);
        expect([firstPage.total, secondPage.total]).toEqual([2, 2]);
      });

      it('returns an empty page beyond the last one', async () => {
        await createCustomRole('EDITOR', []);

        await expect(
          reader.listForActor(ownerId, organizationId, listQuery({ page: 5 })),
        ).resolves.toMatchObject({ items: [], total: 1 });
      });

      it('requires role read access', async () => {
        await expect(
          reader.listForActor(outsiderId, organizationId, listQuery()),
        ).rejects.toMatchObject({ status: 403 });
      });
    });

    describe('catalog', () => {
      it('offers owners every assignable permission except the audit permission', async () => {
        const catalog = await reader.catalogForActor(ownerId, organizationId);

        expect(catalog).toHaveLength(organizationPermissions.length - 1);
        expect(catalog.map(({ resource }) => resource)).not.toContain(
          'ORGANIZATION_AUDIT_LOG',
        );
      });

      it('offers delegates only the permissions they hold', async () => {
        await grantDelegateRole('ROLE_READER', [
          ['ORGANIZATION_ROLE', 'read'],
          ['ORGANIZATION', 'read'],
        ]);

        const catalog = await reader.catalogForActor(
          delegateId,
          organizationId,
        );

        expect(
          catalog.map(({ resource, action }) =>
            permissionKey(resource, action),
          ),
        ).toEqual(['ORGANIZATION:read', 'ORGANIZATION_ROLE:read']);
      });

      it('requires role read access', async () => {
        await expect(
          reader.catalogForActor(outsiderId, organizationId),
        ).rejects.toMatchObject({ status: 403 });
      });
    });
  },
);
