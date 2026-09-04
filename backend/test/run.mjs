import processControl from './process-control.test.mjs';
import workerEndpoints from './worker-endpoints.test.mjs';
import renderPipeline from './render-pipeline.test.mjs';
import workers from './workers.test.mjs';
import health from './health.test.mjs';
import security from './security.test.mjs';
import api from './api.test.mjs';
import paging from './paging.test.mjs';
import chunkedUpload from './chunked-upload.test.mjs';
import workerCredentials from './worker-credentials.test.mjs';
import testFrame from './test-frame.test.mjs';
import tiles from './tiles.test.mjs';
import downloads from './downloads.test.mjs';
import scheduling from './scheduling.test.mjs';
import sceneReading from './scene-reading.test.mjs';

const suites = [
  ['Process control', processControl],
  ['Worker callback endpoints', workerEndpoints],
  ['Render pipeline', renderPipeline],
  ['Workers', workers],
  ['Health endpoint', health],
  ['Security', security],
  ['API, rendering and persistence', api],
  ['Job list paging', paging],
  ['Chunked uploads', chunkedUpload],
  ['Worker credentials', workerCredentials],
  ['Test frame before the rest', testFrame],
  ['Tiled stills', tiles],
  ['Downloads and persistence', downloads],
  ['Scheduling and overrides', scheduling],
  ['Reading an uploaded scene', sceneReading]
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
