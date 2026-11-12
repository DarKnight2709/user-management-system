export interface User {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
  birthDate: Date;
  email: string;
  /** When the address was proven to belong to the owner; null until then. */
  emailVerifiedAt: Date | null;
  hashedPassword?: string;
  avatarUrl?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaginatedUsers {
  items: User[];
  total: number;
  page: number;
  limit: number;
}
