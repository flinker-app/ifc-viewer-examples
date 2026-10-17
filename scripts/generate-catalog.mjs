import { generate } from './example-metadata.mjs';
import { syncExampleDownloads } from './example-download.mjs';
import { syncExampleIfc } from './example-ifc.mjs';

const check = process.argv.includes('--check');
syncExampleDownloads({ check });
syncExampleIfc({ check });
const examples = generate({ check });
console.log(`${check ? 'Checked' : 'Generated'} catalog, README table and SEO metadata for ${examples.length} standalone HTML examples.`);
