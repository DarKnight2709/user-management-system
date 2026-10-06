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
