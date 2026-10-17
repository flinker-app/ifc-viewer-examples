// Read native entities through a separately owned model for browser checks.
export async function readNativeEntities(page, type, limit = 0) {
  return page.evaluate(async ({ type, limit }) => {
    const { assets } = JSON.parse(document.getElementById('example-data').textContent);
    const asset = assets.find(asset => asset.format === 'IFC');
    const response = await fetch(asset.url);
    if (!response.ok) throw new Error(`IFC probe download failed: ${response.status}`);
    const api = await window.exampleViewer.IfcAPI;
    // GetVersion requires initialization; preserve a host-owned native model.
    let initialized = false;
    try { api.GetVersion(); initialized = true; } catch {}
    if (!initialized) await api.Init();
    let modelID = -1;
    try {
      modelID = api.OpenModel(new Uint8Array(await response.arrayBuffer()));
      if (modelID < 0) throw new Error('IFC probe could not open the source model.');
      const vector = api.GetLineIDsWithType(modelID, api.GetTypeCodeFromName(type), true);
      try {
        const total = vector.size();
        const ids = Array.from({ length: Math.min(total, limit) }, (_, index) => vector.get(index));
        return { total, rows: ids.length ? api.GetLines(modelID, ids) : [] };
      } finally { vector.delete(); }
    } finally {
      if (modelID >= 0) api.CloseModel(modelID);
      if (!initialized) api.Dispose();
    }
  }, { type, limit });
}
