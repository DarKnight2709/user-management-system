export interface User {
  id: string;
  name: string;
  age: number;
  email: string;
  hashedPassword?: string;
  createdAt: Date;
  updatedAt: Date;
}
