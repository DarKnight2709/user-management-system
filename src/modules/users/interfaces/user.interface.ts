export interface User {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
  birthDate: Date;
  email: string;
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
