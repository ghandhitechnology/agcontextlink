// Imported first by every test so the server modules read the test settings.
const url = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/agcontextlink_test';
if (!/test/i.test(new URL(url).pathname)) {
  throw new Error('Tests wipe their database, so TEST_DATABASE_URL must name a database with "test" in it.');
}
process.env.DATABASE_URL = url;
process.env.QUIET_LOGS = 'true';
process.env.PUBLIC_URL = 'http://acl.test';
