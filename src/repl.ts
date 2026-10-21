import { repl } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module.js';
async function bootstrap() {
  const replServer = await repl(AppModule);
  replServer.setupHistory('.nest_repl_history', (err) => {
    if (err) {
      Logger.warn(
        {
          message: 'REPL history could not be initialized',
          event: 'repl.history_unavailable',
        },
        'REPL',
      );
    }
  });
}
await bootstrap();
