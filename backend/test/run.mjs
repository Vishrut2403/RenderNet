import workerEndpoints from './worker-endpoints.test.mjs';
import api from './api.test.mjs';

const suites = [
  ['Worker callback endpoints', workerEndpoints],
  ['API, rendering and persistence', api]
];

const totals = { pass: 0, fail: 0, skip: 0 };
const failures = [];

for (const [title, suite] of suites) {
  console.log(`\n${title}`);
  console.log('='.repeat(title.length));

  try {
    const result = await suite();
    totals.pass += result.pass;
    totals.fail += result.fail;
    totals.skip += result.skip;
    failures.push(...result.failures);
  } catch (error) {
    totals.fail++;
    failures.push(`${title}: suite crashed - ${error.message}`);
    console.error(`\n  Suite crashed: ${error.stack}`);
  }
}

console.log(`\n${'-'.repeat(40)}`);
console.log(`${totals.pass} passed, ${totals.fail} failed, ${totals.skip} skipped`);

if (failures.length) {
  console.log('\nFailures:');
  for (const failure of failures) console.log(`  - ${failure}`);
}

process.exit(totals.fail === 0 ? 0 : 1);
