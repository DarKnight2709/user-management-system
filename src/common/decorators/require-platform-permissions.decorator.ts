import { SetMetadata } from '@nestjs/common';

export const PLATFORM_PERMISSIONS_KEY = 'requiredPlatformPermissions';

export interface PlatformPermission {
  resource: string;
  action: string;
}

export const RequirePlatformPermissions = (
  ...permissions: PlatformPermission[]
) => SetMetadata(PLATFORM_PERMISSIONS_KEY, permissions);
