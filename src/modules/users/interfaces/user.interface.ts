export interface User {
  id: string;
  name: string;
  age: number;
  email: string;
  hashedPassword?: string;
  avatarUrl?: string | null;
  createdAt: Date;
  updatedAt: Date;
}
