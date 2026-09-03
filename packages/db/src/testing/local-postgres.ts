import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import type { Db } from '../client'

const run = promisify(execFile)

export const MIGRATIONS_DIR = new URL('../../migrations', import.meta.url).pathname

/**
 * Stand-in for what a Supabase project provides out of the box: the auth schema with a
 * users table and auth.uid(), and the anon/authenticated/service_role roles. Idempotent,
 * so it is safe against a real Supabase local stack too.
 */
export const SUPABASE_STANDIN = `
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'auth' and p.proname = 'uid') then
    create function auth.uid() returns uuid language sql stable as
      $f$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`

export const GRANTS = `
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
`

/** Apply the Supabase stand-in, all migrations, and role grants. Idempotent. */
export async function prepareDatabase(db: Db) {
  await db.execute(sql.raw(SUPABASE_STANDIN))
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR })
  await db.execute(sql.raw(GRANTS))
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      const port = typeof address === 'object' && address ? address.port : 0
      srv.close(() => resolve(port))
    })
  })
}

function pgBin(name: string): string {
  const dir = process.env.PG_BIN_DIR
  return dir ? join(dir, name) : name
}

export type LocalCluster = {
  url: string
  port: number
  dir: string
  stop: () => Promise<void>
}

/**
 * Starts a throwaway Postgres cluster with the local `initdb`/`pg_ctl` (Homebrew,
 * Postgres.app, apt). Set PG_BIN_DIR if they are not on PATH.
 */
export async function startLocalCluster(options: { port?: number } = {}): Promise<LocalCluster> {
  const dir = await mkdtemp(join(tmpdir(), 'tela-pg-'))
  const port = options.port ?? (await freePort())
  try {
    await run(pgBin('initdb'), [
      '-D',
      dir,
      '-U',
      'postgres',
      '--auth=trust',
      '-E',
      'UTF8',
      '--locale=C',
    ])
  } catch (err) {
    await rm(dir, { recursive: true, force: true })
    throw new Error(
      'Could not run initdb. Install Postgres (brew install postgresql@17), set PG_BIN_DIR, ' +
        `or point TEST_DATABASE_URL at a running database.\n${String(err)}`,
    )
  }
  await run(pgBin('pg_ctl'), [
    '-D',
    dir,
    '-o',
    `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off`,
    '-l',
    join(dir, 'server.log'),
    '-w',
    'start',
  ])
  return {
    url: `postgresql://postgres@127.0.0.1:${port}/postgres`,
    port,
    dir,
    stop: async () => {
      await run(pgBin('pg_ctl'), ['-D', dir, '-m', 'immediate', '-w', 'stop']).catch(() => {})
      await rm(dir, { recursive: true, force: true })
    },
  }
}
