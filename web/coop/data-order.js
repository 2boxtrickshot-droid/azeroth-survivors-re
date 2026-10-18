// Same later-wins archive ordering as benilla-formats/src/chain.rs.
export const BASE = ['dbc.mpq', 'speech.mpq', 'fonts.mpq', 'interface.mpq', 'misc.mpq', 'sound.mpq', 'wmo.mpq', 'terrain.mpq', 'texture.mpq', 'model.mpq'];
export function orderArchives(files) {
  const byName = new Map();
  for (const file of files) {
    const name = file.name.toLowerCase();
    if (!name.endsWith('.mpq')) continue;
    if (byName.has(name)) throw new Error(`Duplicate archive: ${file.name}. Select one Data folder.`);
    byName.set(name, file);
  }
  const missing = BASE.filter(n => !byName.has(n));
  if (missing.length) throw new Error(`Missing WoW 1.12.1 archives: ${missing.join(', ')}`);
  const names = [...BASE, 'patch.mpq', ...[...byName.keys()].filter(n => /^patch-.\.mpq$/.test(n)).sort(), 'speech2.mpq'];
  return names.filter(n => byName.has(n)).map(n => byName.get(n));
}
