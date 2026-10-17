import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

// Inlined into standalone examples; model ownership stays with the host page.
export async function withIfcModel(blob, read) {
    const api = await viewer.IfcAPI;
    await api.Init();
    let modelID = -1;
    try {
        modelID = api.OpenModel(new Uint8Array(await blob.arrayBuffer()));
        if (modelID < 0) throw new Error('The native IFC API could not open the model.');
        return await read(api, modelID);
    } finally {
        if (modelID >= 0) api.CloseModel(modelID);
        api.Dispose();
    }
}

export async function readIfcLines(api, modelID, ids, recursive = false) {
    const rows = [];
    for (let start = 0; start < ids.length; start += 96) {
        rows.push(...api.GetLines(modelID, ids.slice(start, start + 96), recursive));
    }
    return rows;
}

export async function queryType(api, modelID, name, recursive = false) {
    const vector = api.GetLineIDsWithType(modelID, api.GetTypeCodeFromName(name), true);
    try {
        const ids = Array.from({ length: vector.size() }, (_, index) => vector.get(index));
        return await readIfcLines(api, modelID, ids, recursive);
    } finally { vector.delete(); }
}

export function dms(value) {
    const degrees = Math.floor(Math.abs(value));
    const minutes = Math.floor((Math.abs(value) - degrees) * 60);
    const microseconds = Math.round(((Math.abs(value) - degrees) * 60 - minutes) * 60 * 1e6);
    const sign = value < 0 ? -1 : 1;
    return [degrees, minutes, Math.floor(microseconds / 1e6), microseconds % 1e6].map(part => part * sign);
}

export async function correctSampleGeoreference(file, geo) {
    return withIfcModel(file, async (api, modelID) => {
        if (api.GetModelSchema(modelID) !== 'IFC2X3') throw new Error('The S1 correction requires the pinned IFC2X3 source.');
        const project = (await queryType(api, modelID, 'IFCPROJECT'))[0];
        if (!project) throw new Error('The S1 source project metadata is missing.');
        const type = (name, value) => api.CreateIfcType(modelID, api.GetTypeCodeFromName(name), value);
        const entity = (name, ...args) => api.CreateIfcEntity(modelID, api.GetTypeCodeFromName(name), ...args);
        const north = entity('IFCDIRECTION', [-geo.xAxisOrdinate, geo.xAxisAbscissa]);
        for (const site of await queryType(api, modelID, 'IFCSITE')) {
            site.RefLatitude = dms(geo.latitude).map(value => type('IFCINTEGER', value));
            site.RefLongitude = dms(geo.longitude).map(value => type('IFCINTEGER', value));
            site.RefElevation = type('IFCLENGTHMEASURE', 0);
            api.WriteLine(modelID, site);
        }
        for (const context of await queryType(api, modelID, 'IFCGEOMETRICREPRESENTATIONCONTEXT')) {
            // Subcontexts inherit this attribute; only the parent context owns it.
            if (context.type !== api.GetTypeCodeFromName('IFCGEOMETRICREPRESENTATIONCONTEXT')) continue;
            context.TrueNorth = north;
            // Read values may retain their STEP spelling; browser writes need numbers.
            context.CoordinateSpaceDimension = type('IFCDIMENSIONCOUNT', Number(context.CoordinateSpaceDimension.value));
            if (context.Precision !== null) context.Precision = type('IFCREAL', Number(context.Precision.value));
            api.WriteLine(modelID, context);
        }
        // SaveModel double-escapes existing apostrophes in typed text values in
        // this web-ifc release. Native WriteLine preserves their original text.
        for (const property of await queryType(api, modelID, 'IFCPROPERTYSINGLEVALUE')) {
            if (typeof property.NominalValue?.value === 'string' && property.NominalValue.value.includes("'"))
                api.WriteLine(modelID, property);
        }
        const pset = (name, properties) => {
            const values = Object.entries(properties).map(([key, value]) =>
                entity('IFCPROPERTYSINGLEVALUE', type('IFCIDENTIFIER', key), null, value, null));
            const set = entity('IFCPROPERTYSET', api.CreateIFCGloballyUniqueId(modelID), project.OwnerHistory,
                type('IFCLABEL', name), type('IFCTEXT', 'Corrected S1 example georeferencing'), values);
            const relation = entity('IFCRELDEFINESBYPROPERTIES', api.CreateIFCGloballyUniqueId(modelID),
                project.OwnerHistory, null, null, [project], set);
            api.WriteLine(modelID, relation);
        };
        pset('ePSet_ProjectedCRS', {
            Name: type('IFCLABEL', 'EPSG:28992'), MapUnit: type('IFCLABEL', 'METRE'),
            Description: type('IFCTEXT', 'S1 example: published RD New horizontal placement; local model heights, no surveyed elevation'),
            VerticalDatum: type('IFCLABEL', 'LOCAL'),
        });
        pset('ePSet_MapConversion', Object.fromEntries(Object.entries({
            Eastings: geo.eastings, Northings: geo.northings, OrthogonalHeight: 0,
            XAxisAbscissa: geo.xAxisAbscissa, XAxisOrdinate: geo.xAxisOrdinate, Scale: geo.scale,
        }).map(([key, value]) => [key, type('IFCREAL', value)])));
        return api.SaveModel(modelID);
    });
}

export async function correctSampleCrs(file, correction) {
    const bytes = await file.arrayBuffer();
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (hash !== correction.sha256) throw new Error('The source differs from the verified sample; its coordinate correction was not applied.');
    return withIfcModel(new Blob([bytes]), (api, modelID) => {
        const ids = api.GetLineIDsWithType(modelID, api.GetTypeCodeFromName('IFCPROJECTEDCRS'), true);
        let records;
        try {
            records = api.GetLines(modelID, Array.from({ length: ids.size() }, (_, index) => ids.get(index)))
                .filter(line => line.Name?.value === correction.expectedName);
        } finally { ids.delete(); }
        if (records.length !== 1 || records[0].VerticalDatum !== null)
            throw new Error('The sample CRS differs from its published reference.');
        const crs = records[0];
        crs.VerticalDatum = api.CreateIfcType(modelID, api.GetTypeCodeFromName('IFCIDENTIFIER'), correction.verticalDatum);
        api.WriteLine(modelID, crs);
        return api.SaveModel(modelID);
    });
}

export function syncExampleIfc({ check = false } = {}) {
    const helpers = [withIfcModel, readIfcLines, queryType, dms, correctSampleGeoreference, correctSampleCrs];
    for (const entry of readdirSync(new URL('../examples/', import.meta.url), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const path = new URL(`../examples/${entry.name}/index.html`, import.meta.url);
        const html = readFileSync(path, 'utf8');
        let updated = html;
        for (const helper of helpers) {
            const pattern = new RegExp(`^(?:async )?function ${helper.name}[^\\n]+\\{\\r?\\n[\\s\\S]*?^\\}`, 'm');
            const code = helper.toString().replaceAll('\n', html.includes('\r\n') ? '\r\n' : '\n');
            updated = updated.replace(pattern, () => code);
        }
        if (updated === html) continue;
        if (check) throw new Error(`Outdated native IFC helper: examples/${entry.name}/index.html. Run npm run generate.`);
        writeFileSync(path, updated);
    }
}
