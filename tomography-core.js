// Synthetic parallel-beam tomography of a triangle mesh. Coordinates are in the
// studio's normalized [-2.2, 2.2] cube. Texture color is deliberately not used
// as an attenuation coefficient: an image on a surface is not internal density.
const LIMIT = 2.2;
const index = (x, y, z, n) => x + n * (y + n * z);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function paintLine(slice, n, x0, y0, x1, y1) {
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 1.6));
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(x0 + (x1 - x0) * i / steps);
    const y = Math.round(y0 + (y1 - y0) * i / steps);
    if (x >= 0 && x < n && y >= 0 && y < n) slice[x + n * y] = 1;
  }
}

export function voxelize(triangles, n = 64, solid = false, progress = () => {}) {
  const volume = new Float32Array(n * n * n);
  const scale = n / (LIMIT * 2);
  for (let z = 0; z < n; z++) {
    const plane = -LIMIT + (z + .5) / scale;
    const slice = volume.subarray(z * n * n, (z + 1) * n * n);
    const rows = solid ? Array.from({ length: n }, () => []) : null;
    for (let t = 0; t < triangles.length; t += 9) {
      const z0 = triangles[t + 2], z1 = triangles[t + 5], z2 = triangles[t + 8];
      if (plane < Math.min(z0, z1, z2) || plane >= Math.max(z0, z1, z2)) continue;
      const points = [];
      for (const [a, b] of [[0, 3], [3, 6], [6, 0]]) {
        const az = triangles[t + a + 2], bz = triangles[t + b + 2];
        if ((az <= plane && bz > plane) || (bz <= plane && az > plane)) {
          const f = (plane - az) / (bz - az);
          points.push([(triangles[t + a] + f * (triangles[t + b] - triangles[t + a]) + LIMIT) * scale - .5,
            (triangles[t + a + 1] + f * (triangles[t + b + 1] - triangles[t + a + 1]) + LIMIT) * scale - .5]);
        }
      }
      if (points.length !== 2) continue;
      const [[x0, y0], [x1, y1]] = points;
      paintLine(slice, n, x0, y0, x1, y1);
      if (rows && y0 !== y1) {
        const start = Math.max(0, Math.ceil(Math.min(y0, y1)));
        const end = Math.min(n - 1, Math.floor(Math.max(y0, y1)));
        for (let y = start; y <= end; y++) {
          const hit = x0 + (x1 - x0) * (y - y0) / (y1 - y0);
          if (hit >= -.5 && hit <= n - .5) rows[y].push(hit);
        }
      }
    }
    if (rows) for (let y = 0; y < n; y++) {
      const hits = rows[y].sort((a, b) => a - b);
      // Opposite-facing triangle pairs may produce coincident hits. Collapse them.
      const unique = [];
      for (const hit of hits) if (!unique.length || hit - unique.at(-1) > .15) unique.push(hit);
      for (let i = 0; i + 1 < unique.length; i += 2)
        for (let x = Math.max(0, Math.ceil(unique[i])); x <= Math.min(n - 1, Math.floor(unique[i + 1])); x++) slice[x + n * y] = 1;
    }
    if (z % 4 === 0 || z === n - 1) progress((z + 1) / n);
  }
  return volume;
}

function address(u, v, s, axis, n) {
  if (axis === 'x') return index(s, u, v, n);
  if (axis === 'y') return index(u, s, v, n);
  return index(u, v, s, n);
}

export function projectVolume(volume, n, { axis = 'y', angles = 72, span = 180, offset = 0 }, progress = () => {}) {
  const detectors = Math.ceil(n * Math.SQRT2) + 2;
  const projections = new Float32Array(n * angles * detectors);
  const center = (n - 1) / 2, detectorCenter = (detectors - 1) / 2;
  for (let a = 0; a < angles; a++) {
    const theta = (offset + a * span / angles) * Math.PI / 180;
    const co = Math.cos(theta), si = Math.sin(theta);
    for (let v = 0; v < n; v++) for (let u = 0; u < n; u++) {
      const detector = (u - center) * co + (v - center) * si + detectorCenter;
      const d0 = Math.floor(detector), f = detector - d0;
      if (d0 < 0 || d0 + 1 >= detectors) continue;
      for (let s = 0; s < n; s++) {
        const density = volume[address(u, v, s, axis, n)];
        if (!density) continue;
        const base = (s * angles + a) * detectors + d0;
        projections[base] += density * (1 - f);
        projections[base + 1] += density * f;
      }
    }
    if (a % 8 === 0 || a === angles - 1) progress((a + 1) / angles);
  }
  return { projections, detectors };
}

export function reconstruct(projections, n, { axis = 'y', angles = 72, span = 180, offset = 0, filter = 'ramp' }, detectors, progress = () => {}) {
  const filtered = new Float32Array(projections.length);
  const kernel = new Float32Array(detectors * 2 - 1);
  for (let k = -detectors + 1; k < detectors; k++)
    kernel[k + detectors - 1] = k === 0 ? .25 : Math.abs(k) % 2 ? -1 / (Math.PI * Math.PI * k * k) : 0;
  for (let s = 0; s < n; s++) for (let a = 0; a < angles; a++) {
    const base = (s * angles + a) * detectors;
    if (filter === 'backprojection') { filtered.set(projections.subarray(base, base + detectors), base); continue; }
    for (let d = 0; d < detectors; d++) {
      let value = 0;
      for (let j = 0; j < detectors; j++) value += projections[base + j] * kernel[d - j + detectors - 1];
      filtered[base + d] = value;
    }
    if (filter === 'soft') {
      const temp = filtered.slice(base, base + detectors);
      for (let d = 1; d < detectors - 1; d++) filtered[base + d] = .25 * temp[d - 1] + .5 * temp[d] + .25 * temp[d + 1];
    }
  }
  const output = new Float32Array(n * n * n);
  const center = (n - 1) / 2, detectorCenter = (detectors - 1) / 2;
  for (let s = 0; s < n; s++) {
    for (let v = 0; v < n; v++) for (let u = 0; u < n; u++) {
      let value = 0;
      for (let a = 0; a < angles; a++) {
        const theta = (offset + a * span / angles) * Math.PI / 180;
        const detector = (u - center) * Math.cos(theta) + (v - center) * Math.sin(theta) + detectorCenter;
        const d0 = Math.floor(detector), f = detector - d0;
        if (d0 >= 0 && d0 + 1 < detectors) {
          const base = (s * angles + a) * detectors + d0;
          value += filtered[base] * (1 - f) + filtered[base + 1] * f;
        }
      }
      output[address(u, v, s, axis, n)] = Math.max(0, value * Math.PI / angles);
    }
    if (s % 4 === 0 || s === n - 1) progress((s + 1) / n);
  }
  return output;
}

export function normalizeVolume(volume, percentile = .995) {
  const values = Array.from(volume).filter(v => v > 0).sort((a, b) => a - b);
  const scale = values.length ? values[clamp(Math.floor(values.length * percentile), 0, values.length - 1)] || 1 : 1;
  const output = new Uint8Array(volume.length);
  for (let i = 0; i < volume.length; i++) output[i] = Math.round(255 * clamp(volume[i] / scale, 0, 1));
  return output;
}
