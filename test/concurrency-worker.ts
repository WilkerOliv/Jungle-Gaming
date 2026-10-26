import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { WageringService } from '../src/application/wagering/wagering.service';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => { input += chunk; });
process.stdin.on('end', async () => {
  const db = new DataSource({ type: 'postgres', url: process.env.TEST_DATABASE_URL });
  try {
    await db.initialize();
    const result = await new WageringService(db).submit(JSON.parse(input));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    if (db.isInitialized) await db.destroy();
  }
});
