import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GlobalSetupContext } from 'vitest/node';

/**
 * Starts a real PostgreSQL for the integration tests and applies the project's
 * migrations to it, so the tests exercise the same schema production uses.
 *
 * With TEST_DATABASE_URL set (CI, or a developer's own server) that database is
 * used as it is and must be empty or disposable. Otherwise a private server
 * is started from the embedded-postgres dev dependency in a temporary
 * directory and removed afterwards, which needs no Docker and no install.
 */

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolvePort(port));
    });
  });
}

function migrate(databaseUrl: string): void {
  const require = createRequire(import.meta.url);
  const prismaCli = require.resolve('prisma/build/index.js');
  try {
    execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });
  } catch (err) {
    // The default error carries the child's whole output as raw bytes.
    const output = (err as { stderr?: Buffer; stdout?: Buffer });
    throw new Error(`Applying migrations failed:
${output.stderr?.toString() ?? ''}${output.stdout?.toString() ?? ''}`, { cause: err });
  }
}

export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  const supplied = process.env['TEST_DATABASE_URL'];
  if (supplied) {
    migrate(supplied);
    provide('databaseUrl', supplied);
    return async () => undefined;
  }

  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const dir = mkdtempSync(join(tmpdir(), 'trip-pg-'));
  const port = await freePort();
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'trip',
    password: 'trip',
    port,
    persistent: false,
    // A cluster made on Windows would otherwise take the machine's ANSI code
    // page, and migrations with any non-ASCII character in them would fail
    // here but not in the UTF-8 database the container image gives.
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => undefined,
    onError: () => undefined,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('trip_test');
  const url = `postgresql://trip:trip@127.0.0.1:${port}/trip_test`;
  migrate(url);
  provide('databaseUrl', url);

  return async () => {
    await pg.stop();
    rmSync(dir, { recursive: true, force: true });
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}
