import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../src/prisma/prisma.service';
import { e2eSchema } from './e2e-schema';

export async function withBlockedInsert<T>(
  prisma: PrismaService,
  table: 'ValidationResult' | 'GeneratedDocument' | 'ExtractionAttempt',
  run: () => Promise<T>,
): Promise<T> {
  const schema = e2eSchema();
  const marker = randomUUID().replaceAll('-', '');
  const functionName = `audit_block_${table.toLowerCase()}_${marker}`;
  const triggerName = `${functionName}_trg`;
  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION "${schema}"."${functionName}"() RETURNS trigger AS $$
     BEGIN
       RAISE EXCEPTION 'fault injection: % insert blocked', TG_TABLE_NAME;
     END;
     $$ LANGUAGE plpgsql`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "${schema}"."${table}"
     FOR EACH ROW EXECUTE FUNCTION "${schema}"."${functionName}"()`,
  );
  try {
    return await run();
  } finally {
    await prisma.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS "${triggerName}" ON "${schema}"."${table}"`,
    );
    await prisma.$executeRawUnsafe(
      `DROP FUNCTION IF EXISTS "${schema}"."${functionName}"()`,
    );
  }
}
