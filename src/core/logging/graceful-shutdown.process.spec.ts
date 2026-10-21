import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';

describe('Shutdown in a separate Node process', () => {
  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)(
    'preserves final lifecycle output before exiting for simulated %s',
    async (signal, exitCode) => {
      const script = `
      import 'reflect-metadata';
      import { Module } from '@nestjs/common';
      import { NestFactory } from '@nestjs/core';
      import { WinstonLogger } from 'nest-winston';
      import { createLogger, format, transports } from 'winston';
      import { registerGracefulShutdown } from './src/core/logging/graceful-shutdown.ts';
      const logger = createLogger({ format: format.json(), transports: [new transports.Console()] });
      class FixtureWorker {
        async onModuleDestroy() {
          await new Promise((resolve) => setImmediate(resolve));
          logger.info('Worker stopped');
        }
        onApplicationShutdown(signal) {
          logger.info('Final lifecycle record', { signal });
        }
      }
      class FixtureModule {}
      Module({ providers: [FixtureWorker] })(FixtureModule);
      const app = await NestFactory.createApplicationContext(FixtureModule, { logger: new WinstonLogger(logger) });
      registerGracefulShutdown(app, logger);
      process.emit('${signal}');
    `;
      const result = await new Promise<{
        code: number | null;
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', '--input-type=module', '--eval', script],
          { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
          stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString();
        });
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('Fixture process timed out'));
        }, 8_000);
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr });
        });
      });
      expect(result.code, result.stderr).toBe(exitCode);
      const records = result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(records).toContainEqual(
        expect.objectContaining({ message: 'Worker stopped' }),
      );
      expect(records.at(-1)).toMatchObject({
        message: 'Final lifecycle record',
        signal,
      });
    },
    10_000,
  );
});
