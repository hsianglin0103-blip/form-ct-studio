import { parseOBJ } from './obj-parser.js';
self.onmessage = async ({ data }) => {
  try {
    const result = await parseOBJ(data.file, (percent, message) => self.postMessage({ type: 'progress', percent, message }));
    self.postMessage({ type: 'complete', result }, [result.position.buffer, result.normal.buffer, result.uv.buffer]);
  } catch (error) { self.postMessage({ type: 'error', message: error.message || 'Unable to read this OBJ.' }); }
};
