import type { PrismaClient } from '../../src/generated/prisma/client.js';
import Joi from 'joi';
import { hash } from '../../src/common/utils/hash.util.js';

export class AdminSeedError extends Error {}

interface AdminConfig {
  email: string;
  username: string;
  password: string;
  firstName: string;
  lastName: string;
  birthDate: Date;
}

function readAdminConfig(): AdminConfig {
  const schema = Joi.object<AdminConfig>({
    email: Joi.string().trim().lowercase().email().required(),
    username: Joi.string().trim().lowercase().min(1).required(),
    password: Joi.string().min(15).pattern(/\S/).required(),
    firstName: Joi.string().trim().min(1).required(),
    lastName: Joi.string().trim().min(1).required(),
    birthDate: Joi.date().iso().max('now').required(),
  });
  const result = schema.validate({
    email: process.env.SEED_ADMIN_EMAIL,
    username: process.env.SEED_ADMIN_USERNAME,
    password: process.env.SEED_ADMIN_PASSWORD,
    firstName: process.env.SEED_ADMIN_FIRST_NAME,
    lastName: process.env.SEED_ADMIN_LAST_NAME,
    birthDate: process.env.SEED_ADMIN_BIRTH_DATE,
  });
  // Report field names only; validation messages can contain supplied values.
  if (result.error) {
    throw new AdminSeedError(
      `Invalid admin seed field: ${result.error.details[0].path.join('.')}`,
    );
  }
  const config = result.value;
  if (Buffer.byteLength(config.password, 'utf8') > 72) {
    throw new AdminSeedError('Admin password must not exceed 72 UTF-8 bytes');
  }
  return config;
}

const platformPermissions = [
  {
    resource: 'USER',
    action: 'read',
    description: 'Read accounts across the application',
  },
  {
    resource: 'USER',
    action: 'delete',
    description: 'Soft-delete accounts across the application',
  },
  {
    resource: 'ORGANIZATION',
    action: 'delete',
    description: 'Delete organizations across the application',
  },
];

export async function seedAdmin(prisma: PrismaClient): Promise<void> {
  const config = readAdminConfig();
  const hashedPassword = await hash(config.password);
  const permissionCount = await prisma.$transaction(
    async (manager) => {
      const records = [];

      for (const permission of platformPermissions) {
        const record = await manager.permission.upsert({
          where: {
            action_resource: {
              action: permission.action,
              resource: permission.resource,
            },
          },
          create: permission,
          update: {
            description: permission.description,
            deletedAt: null,
          },
        });

        records.push(record);
      }

      // Global role names are protected by a partial unique index.
      // Look up the null scope explicitly instead of using a nullable compound key.
      let role = await manager.role.findFirst({
        where: { name: 'SUPER_ADMIN', organizationId: null },
      });

      if (role) {
        if (!role.isSystem) {
          throw new AdminSeedError('SUPER_ADMIN must be a system role');
        }
        role = await manager.role.update({
          where: { id: role.id },
          data: { deletedAt: null },
        });
      } else {
        role = await manager.role.create({
          data: {
            name: 'SUPER_ADMIN',
            isSystem: true,
            organizationId: null,
          },
        });
      }

      for (const permission of records) {
        await manager.rolePermission.upsert({
          where: {
            roleId_permissionId: {
              roleId: role.id,
              permissionId: permission.id,
            },
          },
          create: { roleId: role.id, permissionId: permission.id },
          update: { deletedAt: null },
        });
      }

      let admin = await manager.user.findUnique({
        where: { email: config.email },
      });
      if (admin) {
        if (admin.deletedAt !== null) {
          throw new AdminSeedError(
            'Cannot bootstrap a soft-deleted admin account',
          );
        }
        const assignment = await manager.userPlatformRole.findUnique({
          where: { userId_roleId: { userId: admin.id, roleId: role.id } },
        });
        if (!assignment) {
          throw new AdminSeedError(
            'Seed email belongs to an existing account without SUPER_ADMIN; refusing promotion',
          );
        }
        if (assignment.deletedAt !== null) {
          throw new AdminSeedError(
            'SUPER_ADMIN assignment was revoked; refusing automatic restoration',
          );
        }
        // Existing account credentials and profile are deliberately preserved.
      } else {
        const { password: _password, ...profile } = config;
        admin = await manager.user.create({
          data: { ...profile, hashedPassword },
        });
      }

      await manager.userPlatformRole.upsert({
        where: { userId_roleId: { userId: admin.id, roleId: role.id } },
        create: { userId: admin.id, roleId: role.id },
        update: {},
      });

      return records.length;
    },
    { timeout: 10_000 },
  );

  console.log(
    `Seeded admin and SUPER_ADMIN with ${permissionCount} platform permissions`,
  );
}
