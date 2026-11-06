import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { UsersService } from '@/modules/users/users.service.js';
import { AuthService } from '../auth.service.js';
import type { RegisterDto } from '../dto/auth.dto.js';

vi.mock('@/modules/users/users.service.js', () => ({ UsersService: class {} }));
vi.mock('@/common/utils/hash.util.js', () => ({
  hash: vi.fn((plain: string) => Promise.resolve(`hashed:${plain}`)),
  compare: vi.fn((plain: string, hashed: string) =>
    Promise.resolve(`hashed:${plain}` === hashed),
  ),
}));

const storedUser = {
  id: '123e4567-e89b-42d3-a456-426614174001',
  username: 'alice',
  email: 'alice@example.com',
  hashedPassword: 'hashed:correct-password-123',
};

function setup() {
  const users = {
    findOneByEmail: vi.fn().mockResolvedValue(storedUser),
    create: vi.fn().mockResolvedValue({ id: storedUser.id }),
  };
  const logging = { security: vi.fn() };
  const service = new AuthService(
    users as unknown as UsersService,
    logging as unknown as LoggingService,
  );
  return { service, users, logging };
}

describe('AuthService.validateUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns only public identity fields for valid credentials', async () => {
    const { service } = setup();

    await expect(
      service.validateUser('alice@example.com', 'correct-password-123'),
    ).resolves.toEqual({
      id: storedUser.id,
      username: 'alice',
      email: 'alice@example.com',
    });
  });

  it('gives unknown emails and wrong passwords the same error and log', async () => {
    const unknown = setup();
    unknown.users.findOneByEmail.mockResolvedValue(null);
    const wrong = setup();

    const first = await unknown.service
      .validateUser('nobody@example.com', 'whatever', '10.0.0.1', 'agent')
      .catch((e: Error) => e);
    const second = await wrong.service
      .validateUser('alice@example.com', 'wrong-password', '10.0.0.1', 'agent')
      .catch((e: Error) => e);

    expect(first).toMatchObject({
      status: 401,
      message: 'Invalid credentials',
    });
    expect(second).toMatchObject({
      status: 401,
      message: 'Invalid credentials',
    });
    for (const { logging } of [unknown, wrong]) {
      expect(logging.security).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'auth.login.failed',
          actor: { type: 'ANONYMOUS' },
          reasonCode: 'INVALID_CREDENTIALS',
          requestContext: expect.objectContaining({
            sourceIp: '10.0.0.1',
            userAgent: 'agent',
          }),
        }),
      );
    }
  });

  it('does not log the attempted email or password', async () => {
    const { service, logging } = setup();

    await service
      .validateUser('alice@example.com', 'wrong-password')
      .catch(() => undefined);

    const logged = JSON.stringify(logging.security.mock.calls);
    expect(logged).not.toContain('alice@example.com');
    expect(logged).not.toContain('wrong-password');
  });
});

describe('AuthService.register', () => {
  const dto = {
    username: '  Alice ',
    email: ' Alice@Example.COM ',
    password: 'correct-password-123',
    firstName: 'Alice',
    lastName: 'Doe',
    birthDate: new Date('2000-01-01'),
  } as RegisterDto;

  it('hashes the password and normalizes identifiers', async () => {
    const { service, users } = setup();

    await service.register(dto);

    expect(users.create).toHaveBeenCalledWith({
      username: 'alice',
      email: 'alice@example.com',
      hashedPassword: 'hashed:correct-password-123',
      firstName: 'Alice',
      lastName: 'Doe',
      birthDate: dto.birthDate,
    });
  });

  it('logs the registration with the new user id and no secrets', async () => {
    const { service, logging } = setup();

    await service.register(dto, '10.0.0.1', 'agent');

    expect(logging.security).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.registration.succeeded',
        actor: { type: 'ANONYMOUS' },
        target: { type: 'USER', id: storedUser.id },
      }),
    );
    expect(JSON.stringify(logging.security.mock.calls)).not.toContain(
      dto.password,
    );
  });

  it('logs nothing when creation fails', async () => {
    const { service, users, logging } = setup();
    users.create.mockRejectedValue(new Error('duplicate'));

    await expect(service.register(dto)).rejects.toThrow('duplicate');
    expect(logging.security).not.toHaveBeenCalled();
  });
});
