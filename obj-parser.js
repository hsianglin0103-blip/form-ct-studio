// Two-pass streaming OBJ parser shared by the browser worker and the sample converter.
// Typed arrays avoid the memory multiplier of splitting a large file into strings.
async function lines(file, visit, progress) {
  const reader = file.stream().getReader(), decoder = new TextDecoder();
  let carry = '', bytes = 0, last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    carry += decoder.decode(value, { stream: true });
    let start = 0, end;
    while ((end = carry.indexOf('\n', start)) !== -1) {
      visit(carry.slice(start, end).trim()); start = end + 1;
    }
    carry = carry.slice(start);
    if (carry.length > 8e6) throw new Error('An OBJ line is too long. Please triangulate the mesh first.');
    if (bytes - last > 2e6) { progress(bytes / file.size); last = bytes; }
  }
  carry += decoder.decode();
  if (carry.trim()) visit(carry.trim());
  progress(1);
}
export async function parseOBJ(file, onProgress = () => {}) {
  let vc = 0, tc = 0, nc = 0, corners = 0;
  await lines(file, line => {
    if (/^v\s/.test(line)) vc++;
    else if (/^vt\s/.test(line)) tc++;
    else if (/^vn\s/.test(line)) nc++;
    else if (/^f\s/.test(line)) corners += Math.max(0, line.split('#')[0].trim().split(/\s+/).length - 3) * 3;
  }, p => onProgress(Math.round(p * 25), 'Reading mesh structure'));
  if (!vc || !corners) throw new Error('This OBJ contains no polygon faces. Export a polygon mesh and try again.');
  if (corners > 24e6 || vc > 12e6) throw new Error('This mesh is too large for this browser. Reduce it to fewer than 8 million triangles.');
  const vertices = new Float32Array(vc * 3), texcoords = new Float32Array(tc * 2), normals = new Float32Array(nc * 3);
  const position = new Float32Array(corners * 3), uv = new Float32Array(corners * 2), normal = new Float32Array(corners * 3);
  const groups = [], materials = ['default'];
  let vi = 0, ti = 0, ni = 0, out = 0, material = 0;
  function index(s, count) { const i = Number(s); return i < 0 ? count + i : i - 1; }
  function vertex(spec) {
    const a = spec.split('/'), v = index(a[0], vi);
    if (!Number.isInteger(v) || v < 0 || v >= vc) throw new Error('The OBJ has an invalid vertex reference.');
    const p = out * 3;
    position.set(vertices.subarray(v * 3, v * 3 + 3), p);
    if (a[1]) { const t = index(a[1], ti); if (t < 0 || t >= tc) throw new Error('The OBJ has an invalid UV reference.'); uv.set(texcoords.subarray(t * 2, t * 2 + 2), out * 2); }
    if (a[2]) { const n = index(a[2], ni); if (n < 0 || n >= nc) throw new Error('The OBJ has an invalid normal reference.'); normal.set(normals.subarray(n * 3, n * 3 + 3), p); }
    out++;
  }
  function finishNormal(start) {
    if (normal[start] || normal[start + 1] || normal[start + 2]) return;
    const ax = position[start + 3] - position[start], ay = position[start + 4] - position[start + 1], az = position[start + 5] - position[start + 2];
    const bx = position[start + 6] - position[start], by = position[start + 7] - position[start + 1], bz = position[start + 8] - position[start + 2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz) || 1;
    for (let k = 0; k < 9; k += 3) { normal[start + k] = nx / len; normal[start + k + 1] = ny / len; normal[start + k + 2] = nz / len; }
  }
  await lines(file, line => {
    if (!line || line[0] === '#') return;
    const a = line.split('#')[0].trim().split(/\s+/), kind = a[0];
    if (kind === 'v' || kind === 'vt' || kind === 'vn') {
      const count = kind === 'vt' ? 2 : 3;
      const values = a.slice(1, count + 1).map(Number);
      if (values.length !== count || values.some(v => !Number.isFinite(v))) throw new Error('The OBJ contains invalid coordinates.');
      if (kind === 'v') vertices.set(values, vi++ * 3);
      else if (kind === 'vt') texcoords.set(values, ti++ * 2);
      else normals.set(values, ni++ * 3);
    } else if (kind === 'usemtl') {
      const name = a.slice(1).join(' '); material = materials.indexOf(name);
      if (material === -1) { material = materials.length; materials.push(name); }
    } else if (kind === 'f') {
      let group = groups[groups.length - 1];
      if (!group || group.materialIndex !== material) { group = { start: out, count: 0, materialIndex: material }; groups.push(group); }
      for (let j = 2; j < a.length - 1; j++) {
        const start = out * 3; vertex(a[1]); vertex(a[j]); vertex(a[j + 1]); finishNormal(start); group.count += 3;
      }
    }
  }, p => onProgress(25 + Math.round(p * 70), 'Building geometry'));
  return { position, normal, uv, groups, materials, triangles: out / 3, hasUV: tc > 0 };
}
