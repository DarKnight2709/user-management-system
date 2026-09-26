import { Injectable, NotFoundException } from '@nestjs/common';
import { User } from './interfaces/user.interface.js';
import { UserDto } from './dto/user.dto.js';

@Injectable()
export class UsersService {
  private users: User[] = [
    {
      id: '1',
      name: 'quyen tran',
      age: 22,
      email: 'quyentranduy@gmail.com',
    },
  ];

  async findAll(): Promise<User[]> {
    return this.users;
  }

  async findOne(id: string): Promise<User> {
    const existingUser = this.users.find((user) => user.id === id);

    if (!existingUser) {
      throw new NotFoundException('User not Found');
    }

    return existingUser;
  }

  async create(user: UserDto): Promise<User> {
    const id = crypto.randomUUID();
    const newUser: User = { id, ...user };
    this.users.push(newUser);
    return newUser;
  }

  async update(id: string, updateUserDto: UserDto): Promise<User> {
    const index = this.users.findIndex((user) => user.id === id);

    if (index === -1) {
      throw new NotFoundException('User not Found');
    }

    this.users[index] = { ...this.users[index], ...updateUserDto };

    return this.users[index];
  }

  async delete(id: string): Promise<void> {
    await this.findOne(id);
    this.users = this.users.filter((user) => user.id !== id);
  }
}
