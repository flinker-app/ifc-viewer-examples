import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

// Inlined into each HTML page by npm run generate; no runtime dependency.
export async function loadExampleFile(name, url, load = blob => viewer.add(name, blob), size = 0) {
    const show = stage => viewer.setMessage(name + ': ' + stage, { type: 'loading' });
    const chunks = [], chunkSize = 4 * 1024 * 1024;
    let offset = 0, attempts = 0, action = 'download', type = '';
    try {
        await show('Downloading');
        while (!size || offset < size) {
            try {
                const end = Math.min(offset + chunkSize, size || Infinity) - 1;
                const response = await fetch(url, {
                    headers: { Range: 'bytes=' + offset + '-' + end },
                    cache: 'no-store', signal: AbortSignal.timeout(60000),
                });
                if (!response.ok) {
                    await response.body?.cancel();
                    // GitHub raw hides Content-Range from browser JavaScript: probe EOF.
                    if (response.status === 416 && offset && !size) break;
                    throw Object.assign(new Error('HTTP ' + response.status), { retry: [408, 429].includes(response.status) || response.status >= 500 });
                }
                const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
                if (range && Number(range[1]) !== offset) throw new TypeError('Unexpected byte range');
                size ||= Number(range?.[3]) || 0;
                const bytes = await response.arrayBuffer();
                const expected = response.status === 206 ? (size ? Math.min(chunkSize, size - offset) : 0) : size;
                if (!bytes.byteLength || (expected && bytes.byteLength !== expected) || (response.status === 206 && bytes.byteLength > chunkSize))
                    throw new TypeError('Incomplete download at byte ' + offset);
                if (response.status === 200) chunks.length = 0; // Server ignored Range.
                chunks.push(bytes);
                offset = response.status === 200 ? bytes.byteLength : offset + bytes.byteLength;
                type = response.headers.get('content-type') || '';
                attempts = 0;
                if (response.status === 200) break;
                await show('Downloading' + (size ? ' ' + Math.round(offset / size * 100) + '%' : ''));
            }
            catch (error) {
                if (error.retry === false || ++attempts === 3) throw error;
                await show('Retrying download');
                await new Promise(resolve => setTimeout(resolve, 500 * 2 ** (attempts - 1)));
            }
        }
        action = 'open';
        const result = await load(new Blob(chunks, { type }), show);
        if (result?.isError) throw new Error('The viewer could not open the file');
        await viewer.setMessage(null);
        return result;
    }
    catch (error) {
        throw new Error('Could not ' + action + ' ' + name + (action === 'download' ? ' from ' + url : '') + ': ' + error.message, { cause: error });
    }
}

export function syncExampleDownloads({ check = false } = {}) {
    const pattern = /async function loadExampleFile[^\n]+\{\r?\n[\s\S]*?\r?\n\}/;
    for (const entry of readdirSync(new URL('../examples/', import.meta.url), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const path = new URL(`../examples/${entry.name}/index.html`, import.meta.url);
        const html = readFileSync(path, 'utf8');
        const code = loadExampleFile.toString().replaceAll('\n', html.includes('\r\n') ? '\r\n' : '\n');
        const updated = html.replace(pattern, () => code);
        if (updated === html) continue;
        if (check) throw new Error(`Outdated download helper: examples/${entry.name}/index.html. Run npm run generate.`);
        writeFileSync(path, updated);
    }
}
