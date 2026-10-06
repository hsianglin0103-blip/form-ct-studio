import { voxelize, projectVolume, reconstruct, normalizeVolume } from './tomography-core.js';
let source, size = 64;
self.onmessage = ({ data }) => {
  try {
    if (data.type === 'voxelize') {
      size = data.size;
      source = voxelize(data.triangles, size, data.solid, p => self.postMessage({ type: 'progress', phase: 'voxelize', value: p }));
      self.postMessage({ type: 'voxels', volume: normalizeVolume(source) });
    } else if (data.type === 'reconstruct') {
      if (!source) throw new Error('Build the mesh volume first.');
      const { projections, detectors } = projectVolume(source, size, data.options, p => self.postMessage({ type: 'progress', phase: 'project', value: p }));
      const volume = reconstruct(projections, size, data.options, detectors, p => self.postMessage({ type: 'progress', phase: 'reconstruct', value: p }));
      self.postMessage({ type: 'result', volume: normalizeVolume(volume), projections, detectors, options: data.options }, [projections.buffer]);
    }
  } catch (error) { self.postMessage({ type: 'error', message: error.message || String(error) }); }
};
