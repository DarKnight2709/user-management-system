import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '@/modules/users/users.service.js';
import { JwtStrategy } from '../strategies/jwt.strategy.js';

vi.mock('@/modules/users/users.service.js', () => ({ UsersService: class {} }));

function setup() {
  const users = {
    findOne: vi.fn().mockResolvedValue({
      id: 'user-id',
      email: 'alice@example.com',
      username: 'alice',
      hashedPassword: 'must-not-leak',
      firstName: 'Alice',
    }),
  };
  const strategy = new JwtStrategy(
    new ConfigService({ JWT_ACCESS_TOKEN_SECRET: 'unit-test-only-secret' }),
    users as unknown as UsersService,
  );
  return { strategy, users };
}

describe('JwtStrategy.validate', () => {
  it.each([
    ['null', null],
    ['a string', 'sub'],
    ['no sub', {}],
    ['a numeric sub', { sub: 5 }],
    ['a blank sub', { sub: '   ' }],
  ])('rejects a payload that is %s', async (_, payload) => {
    const { strategy, users } = setup();

    await expect(strategy.validate(payload)).rejects.toMatchObject({
      status: 401,
    });
    expect(users.findOne).not.toHaveBeenCalled();
  });

  it('exposes only id, email and username to the request', async () => {
    const { strategy } = setup();

    await expect(strategy.validate({ sub: 'user-id' })).resolves.toEqual({
      id: 'user-id',
      email: 'alice@example.com',
      username: 'alice',
    });
  });

  it('turns a missing or deleted user into 401', async () => {
    const { strategy, users } = setup();
    users.findOne.mockRejectedValue(new NotFoundException());

    await expect(strategy.validate({ sub: 'user-id' })).rejects.toMatchObject({
      status: 401,
    });
  });

  it('does not hide infrastructure errors', async () => {
    const { strategy, users } = setup();
    users.findOne.mockRejectedValue(new Error('db down'));

    await expect(strategy.validate({ sub: 'user-id' })).rejects.toThrow(
      'db down',
    );
  });
});
