export interface User {
  id: string;
  name: string;
  age: number;
  email: string;
  hashedPassword?: string;
  avatarKey?: string | null;
  createdAt: Date;
  updatedAt: Date;
}
