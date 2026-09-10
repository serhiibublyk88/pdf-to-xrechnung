import { Client } from 'pg';

const [, , invoiceId] = process.argv;
if (!invoiceId) {
  console.error('Usage: node seed-needs-review.mjs <invoiceId>');
  process.exit(1);
}

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const result = await client.query(
  'UPDATE "Invoice" SET status = $1 WHERE id = $2',
  ['NEEDS_REVIEW', invoiceId],
);
await client.end();

if (result.rowCount !== 1) {
  console.error(
    `Expected to update exactly one invoice, updated ${result.rowCount}`,
  );
  process.exit(1);
}
