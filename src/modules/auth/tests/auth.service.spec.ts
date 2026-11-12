import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compare } from '@/common/utils/hash.util.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { UsersService } from '@/modules/users/users.service.js';
import { AuthService } from '../auth.service.js';
import type { RegisterDto } from '../dto/auth.dto.js';
import type { EmailVerificationService } from '@/modules/account-security/services/email-verification.service.js';
import { toCredentialRef } from '../utils/credential-ref.util.js';

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
  const emailVerification = { sendTo: vi.fn().mockResolvedValue(undefined) };
  const service = new AuthService(
    users as unknown as UsersService,
    logging as unknown as LoggingService,
    emailVerification as unknown as EmailVerificationService,
  );
  return { service, users, logging, emailVerification };
}

describe('AuthService.validateUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the identity of the matched account', async () => {
    const { service } = setup();

    const result = await service.validateUser(
      'alice@example.com',
      'correct-password-123',
    );

    expect(result).toMatchObject({
      id: storedUser.id,
      username: 'alice',
      email: 'alice@example.com',
    });
  });

  it('binds the result to the password it matched', async () => {
    const { service } = setup();

    const result = await service.validateUser(
      'alice@example.com',
      'correct-password-123',
    );

    expect(result.credentialRef).toBe(
      toCredentialRef(storedUser.hashedPassword),
    );
  });

  it('never returns the stored hash', async () => {
    const { service } = setup();

    const result = await service.validateUser(
      'alice@example.com',
      'correct-password-123',
    );

    expect(JSON.stringify(result)).not.toContain(storedUser.hashedPassword);
  });

  it('spends a bcrypt comparison on unknown emails so latency does not reveal them', async () => {
    const { service, users } = setup();
    users.findOneByEmail.mockResolvedValue(null);

    await service.validateUser('nobody@example.com', 'whatever').catch(() => {
      // expected rejection
    });

    expect(compare).toHaveBeenCalledTimes(1);
    expect(compare).toHaveBeenCalledWith('whatever', expect.any(String));
  });

  it('compares unknown emails against a generated hash, not a stored one', async () => {
    const { service, users } = setup();
    users.findOneByEmail.mockResolvedValue(null);

    await service.validateUser('nobody@example.com', 'whatever').catch(() => {
      // expected rejection
    });

    expect(compare).not.toHaveBeenCalledWith(
      expect.anything(),
      storedUser.hashedPassword,
    );
  });

  it('never accepts an unknown email even if the password matches the dummy hash', async () => {
    const { service, users } = setup();
    users.findOneByEmail.mockResolvedValue(null);
    vi.mocked(compare).mockResolvedValueOnce(true);

    await expect(
      service.validateUser('nobody@example.com', 'whatever'),
    ).rejects.toMatchObject({ status: 401 });
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

  it('sends a verification link to the new account', async () => {
    const { service, emailVerification } = setup();

    await service.register(dto);

    expect(emailVerification.sendTo).toHaveBeenCalledExactlyOnceWith(
      storedUser.id,
    );
  });

  it('sends the link only after the account was created', async () => {
    const { service, users, emailVerification } = setup();

    await service.register(dto);

    expect(users.create.mock.invocationCallOrder[0]).toBeLessThan(
      emailVerification.sendTo.mock.invocationCallOrder[0],
    );
  });

  it('sends no link when creation fails', async () => {
    const { service, users, emailVerification } = setup();
    users.create.mockRejectedValue(new Error('duplicate'));

    await service.register(dto).catch(() => undefined);

    expect(emailVerification.sendTo).not.toHaveBeenCalled();
  });

  it('logs nothing when creation fails', async () => {
    const { service, users, logging } = setup();
    users.create.mockRejectedValue(new Error('duplicate'));

    await expect(service.register(dto)).rejects.toThrow('duplicate');
    expect(logging.security).not.toHaveBeenCalled();
  });
});
