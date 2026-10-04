import { connectDatabase } from '../src/infrastructure/database';
const orm = await connectDatabase();
const versions = ['001_initial', '002_audit', '003_wallet_version', '004_finite_money'];
try {
  await orm.em.fork().transactional(async (em) => {
    await em.execute('SELECT pg_advisory_xact_lock(84720911)');
    await em.execute(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const direction = process.argv[2] ?? 'up';
    if (!['up', 'down'].includes(direction)) throw new Error('Use up ou down');
    const rows = await em.execute<{ version: string }[]>('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.version));
    for (const name of direction === 'up' ? versions : [...versions].reverse()) {
      const version = name.split('_')[0]!;
      if (direction === 'up' ? applied.has(version) : !applied.has(version)) continue;
      await em.execute(
        await Bun.file(new URL(`../migrations/${name}.${direction}.sql`, import.meta.url)).text(),
      );
      if (direction === 'up')
        await em.execute('INSERT INTO schema_migrations(version) VALUES (?)', [version]);
      else await em.execute('DELETE FROM schema_migrations WHERE version=?', [version]);
      console.log(`Migration ${version} ${direction}: OK`);
    }
  });
} finally {
  await orm.close();
}
