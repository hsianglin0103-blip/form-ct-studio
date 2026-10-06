import * as THREE from 'three';
import { exactPixelPaths, exactRGBPaths } from './exact-vector.js';
import { composeReadings, moveReadingLayers, newReadingLayer, READING_LABELS } from './reading-compositor.js';
import { cleanVector, vectorPathSVG } from './clean-vector.js';
import { computePageLayout } from './page-layout.js';

const $ = id => document.getElementById(id);
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const palettes = {
  scanner: [[.96,.97,.94],[1,.65,.18],[.97,.28,.02],[.12,.48,.28],[.04,.23,.70],[.01,.03,.08]],
  mono: [[.015,.025,.04],[.20,.26,.31],[.57,.68,.74],[.91,.97,1]],
  thermal: [[.04,.02,.10],[.38,.04,.25],[.85,.12,.12],[1,.55,.10],[1,.95,.59]],
  cyan: [[.015,.035,.11],[.05,.16,.47],[.06,.54,.76],[.64,.96,.91]]
};
const hexColor=value=>[1,3,5].map(index=>parseInt(value.slice(index,index+2),16));
function color(value, palette) {
  const stops = palette==='custom'
    ?[hexColor($('lab-overlay-dark').value).map(channel=>channel/255),hexColor($('lab-overlay-light').value).map(channel=>channel/255)]
    :(palettes[palette] || palettes.scanner);
  const t = clamp(value) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(t)), f = t - i;
  return stops[i].map((c, k) => Math.round(255 * (c * (1 - f) + stops[i + 1][k] * f)));
}
function rgb(value, palette) { return `rgb(${color(value, palette).join(',')})`; }
function save(blob, filename) {
  if (!blob) return;
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export class TomographyLab {
  constructor(canvas, scene, onResult) {
    this.canvas = canvas; this.scene = scene; this.onResult = onResult;
    this.source = null; this.result = null; this.worker = null; this.points = null;
    this.size = 64; this.busy = false; this.view = '2d'; this.modelName = 'mesh';
    this.detailCache = new Map(); this.layerCache = new Map(); this.compositeCache = null; this.vectorCache = null;
    this.layers = [newReadingLayer(1)]; this.selectedLayerId = 1; this.nextLayerId = 2;
    this.bind(); this.syncLayerControls();
  }
  bind() {
    $('lab-generate').onclick = () => this.generate();
    for (const id of ['lab-material','lab-resolution','lab-axis','lab-angles','lab-span','lab-offset','lab-filter']) {
      $(id).addEventListener('input', () => { this.updateReadouts(); $('lab-status').textContent = 'Settings changed. Generate to apply them.'; });
    }
    for (const [id,key] of [['lab-image','mode'],['lab-detail-view','view'],['lab-slice','slice'],['lab-angle','angle'],['lab-effect','effect'],['lab-layer-opacity','opacity'],['lab-layer-scale','scale'],['lab-layer-rotation','rotation'],['lab-layer-blend','blend']])
      $(id).addEventListener('input', () => this.changeLayer(key, $(id).value));
    for (const [id,axis] of [['lab-layer-x','x'],['lab-layer-y','y']])
      $(id).addEventListener('input', () => { moveReadingLayers(this.layers,this.selectedLayerId,axis,$(id).value,$('lab-link-positions').checked); this.invalidateComposition(); this.updateReadouts(); this.draw(); this.onReadingChange?.(); });
    $('lab-layer-select').addEventListener('change', () => { this.selectedLayerId = +$('lab-layer-select').value; this.syncLayerControls(); this.onReadingChange?.(); });
    $('lab-add-layer').onclick = () => this.addLayer();
    $('lab-remove-layer').onclick = () => this.removeLayer();
    $('lab-layer-up').onclick = () => this.moveLayer(1);
    $('lab-layer-down').onclick = () => this.moveLayer(-1);
    $('lab-layer-visible').addEventListener('change', () => this.changeLayer('visible',$('lab-layer-visible').checked));
    $('lab-align-layers').onclick = () => { for(const layer of this.layers){layer.x=0;layer.y=0;layer.scale=100;layer.rotation=0;} this.syncLayerControls(); this.invalidateComposition(); this.draw(); this.onReadingChange?.(); };
    $('lab-palette').addEventListener('input', () => { this.invalidateComposition(); this.rebuildPoints(); this.draw(); this.onReadingChange?.(); });
    $('lab-palette').addEventListener('change',()=>{$('lab-custom-colors').hidden=$('lab-palette').value!=='custom';});
    for(const id of ['lab-background','lab-overlay-dark','lab-overlay-light'])$(id).addEventListener('input',()=>{this.invalidateComposition();this.draw();this.onReadingChange?.();});
    $('lab-vector-finish').addEventListener('change', () => { $('lab-vector-detail-control').hidden=!$('lab-vector-finish').checked; $('reading-svg-export').textContent=$('lab-vector-finish').checked?'Export clean vector SVG ↗':'Export exact SVG ↗'; this.draw(); this.onReadingChange?.(); });
    for(const id of ['lab-vector-geometry','lab-vector-paint','lab-vector-structure','lab-vector-detail','lab-vector-min-region','lab-vector-small-mode','lab-vector-edges','lab-vector-line-width','lab-vector-line-density','lab-vector-line-color'])$(id).addEventListener('input',()=>{
      for(const key of ['structure','detail','min-region','edges','line-density'])$(`lab-vector-${key}-value`).textContent=`${$(`lab-vector-${key}`).value}%`;
      $('lab-vector-line-width-value').textContent=(+$('lab-vector-line-width').value/10).toFixed(1);
      $('lab-vector-line-controls').hidden=$('lab-vector-paint').value==='fill';
      this.vectorCache=null;this.draw();this.onReadingChange?.();
    });
    for(const id of ['lab-page-ratio','lab-page-width','lab-page-scale','lab-page-x','lab-page-y'])$(id).addEventListener('input',()=>{
      for(const key of ['scale','x','y'])$(`lab-page-${key}-value`).textContent=`${$(`lab-page-${key}`).value}%`;
      this.draw();this.onReadingChange?.();
    });
    $('lab-threshold').addEventListener('input', () => { this.updateReadouts(); this.rebuildPoints(); });
    $('lab-export-png').onclick = () => this.exportPNG();
    $('lab-export-svg').onclick = () => this.onVector?.();
    $('reading-svg-export').onclick = () => this.exportSVG();
    $('reading-vector-edit').onclick = () => this.onVector?.();
  }
  setModel(root, name) {
    this.worker?.terminate(); this.worker = null; this.source = null; this.result = null;
    this.model = root; this.modelName = name; this.removePoints(); this.invalidateDetail();
    this.layers = [newReadingLayer(1)]; this.selectedLayerId = 1; this.nextLayerId = 2; this.syncLayerControls();
    $('lab-status').textContent = 'Ready to scan this mesh.';
    this.updateExportAvailability();
    this.draw();
  }
  invalidateDetail() { this.detailCache.clear(); this.layerCache.clear(); this.compositeCache = null; this.vectorCache=null; }
  invalidateComposition() { this.compositeCache = null; this.vectorCache=null; }
  updateExportAvailability() {
    const ready = !!this.model && this.layers.some(layer => layer.visible) && !this.busy;
    for (const id of ['lab-export-png','lab-export-svg','reading-svg-export','reading-vector-edit','vector-build']) $(id).disabled = !ready;
  }
  options() {
    return { axis: $('lab-axis').value, angles: +$('lab-angles').value,
      span: +$('lab-span').value, offset: +$('lab-offset').value, filter: $('lab-filter').value };
  }
  updateReadouts() {
    $('lab-offset-value').textContent = `${$('lab-offset').value}°`;
    $('lab-slice-value').textContent = `${$('lab-slice').value}%`;
    $('lab-angle-value').textContent = `${$('lab-angle').value}°`;
    $('lab-effect-value').textContent = `${$('lab-effect').value}%`;
    $('lab-threshold-value').textContent = `${$('lab-threshold').value}%`;
    for(const [id,suffix] of [['lab-layer-opacity','%'],['lab-layer-x','%'],['lab-layer-y','%'],['lab-layer-scale','%'],['lab-layer-rotation','°']]) $(`${id}-value`).textContent=`${$(id).value}${suffix}`;
  }
  selectedLayer() { return this.layers.find(layer => layer.id === this.selectedLayerId) || this.layers[0]; }
  changeLayer(key, value) {
    const layer=this.selectedLayer(); if(!layer)return;
    layer[key] = key === 'visible' ? Boolean(value) : ['mode','view','blend'].includes(key) ? value : Number(value);
    this.invalidateComposition(); this.renderLayerList(); this.updateReadouts(); this.updateExportAvailability(); this.draw(); this.onReadingChange?.();
  }
  renderLayerList() {
    const select=$('lab-layer-select'); select.replaceChildren();
    for(const [index,layer] of this.layers.entries()){
      const option=document.createElement('option'); option.value=layer.id;
      option.textContent=`${String(index+1).padStart(2,'0')} · ${layer.visible?'●':'○'} ${READING_LABELS[layer.mode]} / ${layer.view.toUpperCase()} ${layer.angle>=0?'+':''}${layer.angle}°`;
      select.append(option);
    }
    select.value=String(this.selectedLayerId);
    const index=this.layers.findIndex(layer=>layer.id===this.selectedLayerId);
    $('lab-remove-layer').disabled=this.layers.length<=1;
    $('lab-layer-up').disabled=index>=this.layers.length-1;
    $('lab-layer-down').disabled=index<=0;
    $('lab-layer-count').textContent=`${this.layers.filter(layer=>layer.visible).length} visible / ${this.layers.length} layers`;
  }
  syncLayerControls() {
    const layer=this.selectedLayer(); if(!layer)return;
    for(const [id,key] of [['lab-image','mode'],['lab-detail-view','view'],['lab-slice','slice'],['lab-angle','angle'],['lab-effect','effect'],['lab-layer-opacity','opacity'],['lab-layer-x','x'],['lab-layer-y','y'],['lab-layer-scale','scale'],['lab-layer-rotation','rotation'],['lab-layer-blend','blend']]) $(id).value=layer[key];
    $('lab-layer-visible').checked=layer.visible;
    this.renderLayerList(); this.updateReadouts(); this.updateExportAvailability();
  }
  addLayer() {
    if(this.layers.length>=8)return;
    const source=this.selectedLayer(); const layer=newReadingLayer(this.nextLayerId++,{...source,opacity:75,x:Math.min(25,source.x+3),y:Math.min(25,source.y+3)});
    this.layers.push(layer);this.selectedLayerId=layer.id;this.syncLayerControls();this.invalidateComposition();this.draw();this.onReadingChange?.();
    $('lab-add-layer').disabled=this.layers.length>=8;
  }
  removeLayer() {
    if(this.layers.length<=1)return;
    const index=this.layers.findIndex(layer=>layer.id===this.selectedLayerId);
    this.layers.splice(index,1);this.selectedLayerId=this.layers[Math.min(index,this.layers.length-1)].id;
    $('lab-add-layer').disabled=false;this.syncLayerControls();this.invalidateComposition();this.draw();this.onReadingChange?.();
  }
  moveLayer(direction) {
    const index=this.layers.findIndex(layer=>layer.id===this.selectedLayerId),other=index+direction;
    if(other<0||other>=this.layers.length)return;
    [this.layers[index],this.layers[other]]=[this.layers[other],this.layers[index]];
    this.renderLayerList();this.invalidateComposition();this.draw();this.onReadingChange?.();
  }
  resize(width, height, ratio) {
    const w = Math.max(1, Math.round(width * Math.min(ratio, 1.5)));
    const h = Math.max(1, Math.round(height * Math.min(ratio, 1.5)));
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w; this.canvas.height = h; this.draw();
  }
  flattenMesh() {
    if (!this.model) throw new Error('Load a model first.');
    this.model.updateMatrixWorld(true);
    let count = 0;
    this.model.traverse(mesh => { if (mesh.isMesh) count += mesh.geometry.index?.count ?? mesh.geometry.attributes.position?.count ?? 0; });
    if (!count) throw new Error('This model has no triangles to scan.');
    const triangles = new Float32Array(count * 3);
    const vertex = new THREE.Vector3(); let at = 0;
    this.model.traverse(mesh => {
      if (!mesh.isMesh) return;
      const positions = mesh.geometry.attributes.position, indices = mesh.geometry.index;
      for (let i = 0, length = indices?.count ?? positions.count; i < length; i++) {
        const j = indices ? indices.getX(i) : i;
        vertex.set(positions.getX(j), positions.getY(j), positions.getZ(j)).applyMatrix4(mesh.matrixWorld);
        triangles[at++] = vertex.x; triangles[at++] = vertex.y; triangles[at++] = vertex.z;
      }
    });
    return triangles;
  }
  generate() {
    if (!this.model || this.busy) return;
    const n = +$('lab-resolution').value, solid = $('lab-material').value === 'solid';
    const rebuild = !this.worker || n !== this.size || solid !== this.solid;
    this.busy = true; $('lab-generate').disabled = true;
    $('lab-export-png').disabled = true; $('lab-export-svg').disabled = true;
    $('reading-svg-export').disabled = true; $('reading-vector-edit').disabled = true;
    $('vector-build').disabled = true;
    $('lab-status').textContent = rebuild ? 'Preparing mesh triangles…' : 'Scanning from multiple angles…';
    this.result = null; this.removePoints();
    try {
      if (rebuild) {
        this.worker?.terminate(); this.worker = new Worker(new URL('./tomography-worker.js', import.meta.url), { type: 'module' });
        this.worker.onmessage = ({ data }) => this.receive(data);
        this.worker.onerror = () => this.fail('Could not calculate the volume. Try a lower resolution or a simpler mesh.');
        this.size = n; this.solid = solid;
        const triangles = this.flattenMesh();
        this.worker.postMessage({ type: 'voxelize', triangles, size: n, solid }, [triangles.buffer]);
      } else this.worker.postMessage({ type: 'reconstruct', options: this.options() });
    } catch (error) { this.fail(error.message); }
  }
  receive(data) {
    if (data.type === 'progress') {
      const labels = { voxelize: 'Voxelizing mesh', project: 'Collecting angle projections', reconstruct: 'Reconstructing slices' };
      $('lab-status').textContent = `${labels[data.phase]} · ${Math.round(data.value * 100)}%`;
    } else if (data.type === 'voxels') {
      this.source = data.volume;
      this.worker.postMessage({ type: 'reconstruct', options: this.options() });
    } else if (data.type === 'result') {
      this.result = data; this.busy = false; $('lab-generate').disabled = false;
      $('lab-status').textContent = `${this.size}³ voxels · ${data.options.angles} views across ${data.options.span}° · reconstruction ready.`;
      this.updateExportAvailability();
      this.updateReadouts(); this.rebuildPoints(); this.draw(); this.onResult?.();
    } else if (data.type === 'error') this.fail(data.message);
  }
  fail(message) {
    this.busy = false; $('lab-generate').disabled = false;
    $('lab-status').textContent = message; this.updateExportAvailability(); this.onResult?.();
  }
  setView(view) { this.view = view; this.draw(); }
  sample(u, v, s) {
    if (!this.result) return 0;
    const n = this.size, x = Math.round(u), y = Math.round(v), z = Math.round(s);
    if (x < 0 || x >= n || y < 0 || y >= n || z < 0 || z >= n) return 0;
    const axis = this.result.options.axis;
    const i = axis === 'x' ? z + n * (x + n * y) : axis === 'y' ? x + n * (z + n * y) : x + n * (y + n * z);
    return this.result.volume[i] / 255;
  }
  legacyRaster() {
    const mode = $('lab-image').value;
    if (mode === 'detail') return this.detailRaster();
    if (!this.result) return null;
    const { projections, detectors: d, options } = this.result;
    const n = this.size, aCount = options.angles;
    const slice = Math.round(+$('lab-slice').value / 100 * (n - 1));
    const angle = Math.round(+$('lab-angle').value / 100 * (aCount - 1));
    const effect = +$('lab-effect').value / 100;
    let w = n, h = n;
    if (mode === 'projection' || mode === 'warp') w = d;
    if (mode === 'sinogram') { w = d; h = aCount; }
    if (mode === 'wrap') w = n * 2;
    const values = new Float32Array(w * h);
    if (mode === 'slice' || mode === 'vector') {
      for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) values[u + v * w] = this.sample(u, v, slice);
    } else if (mode === 'stack') {
      const radius = Math.max(1, Math.round(effect * n * .28));
      for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) {
        let maximum = 0;
        for (let k = -radius; k <= radius; k++) maximum = Math.max(maximum, this.sample(u, v, slice + k) * (1 - Math.abs(k) / (radius + 1) * .35));
        values[u + v * w] = maximum;
      }
    } else if (mode === 'projection' || mode === 'warp') {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const sourceX = mode === 'warp' ? clamp(Math.round(x + Math.sin(y * .16 + x * .045) * effect * n * .22), 0, d - 1) : x;
        values[x + y * w] = projections[(y * aCount + angle) * d + sourceX];
      }
    } else if (mode === 'sinogram') {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) values[x + y * w] = projections[(slice * aCount + y) * d + x];
    } else if (mode === 'wrap') {
      const radius = n * (.32 + effect * .17), center = (n - 1) / 2;
      for (let s = 0; s < h; s++) for (let x = 0; x < w; x++) {
        const theta = x / w * Math.PI * 2;
        values[x + s * w] = this.sample(center + Math.cos(theta) * radius, center + Math.sin(theta) * radius, s);
      }
    } else if (mode === 'curve') {
      for (let s = 0; s < h; s++) for (let x = 0; x < w; x++) {
        const curve = (n - 1) / 2 + Math.sin(x / (w - 1) * Math.PI * 2) * effect * n * .32;
        values[x + s * w] = this.sample(x, curve, s);
      }
    }
    if (mode === 'projection' || mode === 'warp' || mode === 'sinogram') {
      let max = 0; for (const value of values) max = Math.max(max, value);
      for (let i = 0; i < values.length; i++) values[i] = Math.pow(clamp(values[i] / (max || 1)), .78);
    }
    return { values, w, h, mode, slice, angle };
  }
  detailRaster() {
    if (!this.model || !this.detailedFrame) return null;
    const view = $('lab-detail-view').value, palette = $('lab-palette').value;
    const key = `${view}|${palette}`;
    if (this.detailCache.has(key)) return this.detailCache.get(key);
    const frame = this.detailedFrame(view);
    if (!frame || frame.bounds.maxX < 0) return null;
    const { columns, rows, bounds: b } = frame;
    const pad = Math.max(8, Math.round(Math.max(b.maxX - b.minX + 1, b.maxY - b.minY + 1) * .035));
    const sx = Math.max(0, b.minX - pad), sy = Math.max(0, rows - 1 - b.maxY - pad);
    const ex = Math.min(columns, b.maxX + 1 + pad), ey = Math.min(rows, rows - b.minY + pad);
    const w = ex - sx, h = ey - sy;
    const art = document.createElement('canvas'); art.width = w; art.height = h;
    const ctx = art.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = this.detailPaper?.() || '#f2f6f0'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(frame.art, sx, sy, w, h, 0, 0, w, h);
    const pixels = ctx.getImageData(0, 0, w, h).data;
    if (palette !== 'scanner') for (let i = 0; i < pixels.length; i += 4) {
      const luminance = (pixels[i] * .2126 + pixels[i + 1] * .7152 + pixels[i + 2] * .0722) / 255;
      const mapped = color(luminance, palette);
      pixels[i] = mapped[0]; pixels[i + 1] = mapped[1]; pixels[i + 2] = mapped[2];
    }
    const raster = { pixels, w, h, mode: 'detail', view };
    this.detailCache.set(key, raster);
    return raster;
  }
  raster() {
    if(!this.model||!this.detailedFrame)return null;
    const palette=$('lab-palette').value;
    const paper=$('lab-background').value;
    const key=JSON.stringify([this.layers,palette,paper,$('lab-overlay-dark').value,$('lab-overlay-light').value]);
    if(this.compositeCache?.key===key)return this.compositeCache.raster;
    const raster=composeReadings(this.layers,(view,angle)=>this.detailedFrame(view,angle),paper,palette,color,this.layerCache);
    this.compositeCache={key,raster};
    return raster;
  }
  pageLayout(raster=this.raster()){
    if(!raster)return null;
    return computePageLayout(raster.w,raster.h,{
      ratio:$('lab-page-ratio').value,width:$('lab-page-width').value,
      scale:$('lab-page-scale').value,x:$('lab-page-x').value,y:$('lab-page-y').value,
      background:$('lab-background').value
    });
  }
  vectorFinish() {
    if(!$('lab-vector-finish').checked)return null;
    const raster=this.raster();if(!raster)return null;
    const detail=+$('lab-vector-detail').value;
    const minRegion=+$('lab-vector-min-region').value,edgeReduction=+$('lab-vector-edges').value;
    const smallRegionMode=$('lab-vector-small-mode').value;
    const geometry=$('lab-vector-geometry').value,paint=$('lab-vector-paint').value;
    const structure=+$('lab-vector-structure').value,lineWidth=+$('lab-vector-line-width').value/10;
    const lineDensity=+$('lab-vector-line-density').value,lineColor=$('lab-vector-line-color').value;
    const key=JSON.stringify([detail,minRegion,edgeReduction,smallRegionMode,geometry,paint,structure,lineWidth,lineDensity,lineColor]);
    if(this.vectorCache?.raster===raster&&this.vectorCache.key===key)return this.vectorCache.result;
    const result=cleanVector(raster.pixels,raster.w,raster.h,{detail,minRegion,edgeReduction,smallRegionMode,geometry,paint,structure,lineWidth,lineDensity,lineColor,background:$('lab-background').value});
    this.vectorCache={raster,key,result};
    $('lab-vector-stats').textContent=`${result.stats.regions.toLocaleString()} regions · ${result.stats.edges.toLocaleString()} edges · ${result.stats.lineSegments.toLocaleString()} lines · ${result.stats.mergedComponents.toLocaleString()} merged`;
    return result;
  }
  draw() {
    if (this.view !== '2d') return;
    const ctx = this.canvas.getContext('2d'), w = this.canvas.width, h = this.canvas.height;
    if (!w || !h) return;
    const preview=$('clean-vector-preview');preview.hidden=true;
    ctx.fillStyle='#192120';ctx.fillRect(0,0,w,h);
    const raster = this.raster();
    ctx.textAlign = 'left'; ctx.fillStyle='#a9c4a9';
    ctx.font = `${Math.max(11, w * .013)}px Consolas, monospace`;
    ctx.fillText(`HIGH-DEFINITION CT  /  ${raster?.layerCount || 0} REGISTERED READING${raster?.layerCount===1?'':'S'}`, w * .035, h * .055);
    if (!raster) {
      ctx.font = `${Math.max(18, w * .026)}px Segoe UI, sans-serif`;
      ctx.fillText(this.model?'Enable a reading layer to see the composition.':'Load a mesh to create high-definition 2D readings.', w * .08, h * .5);
      return;
    }
    const { w: rw, h: rh } = raster;
    const art = document.createElement('canvas'); art.width = rw; art.height = rh;
    const pixels = art.getContext('2d').createImageData(rw, rh);
    pixels.data.set(raster.pixels);
    art.getContext('2d').putImageData(pixels, 0, 0);
    const page=this.pageLayout(raster);
    $('lab-page-info').textContent=`${page.w.toLocaleString()} × ${page.h.toLocaleString()} px page`;
    const margin = Math.min(w,h) * .065, top = h * .11, availableW = w - margin * 2, availableH = h - top - margin;
    const pageScale=Math.min(availableW/page.w,availableH/page.h);
    const pageW=page.w*pageScale,pageH=page.h*pageScale;
    const pageLeft=(w-pageW)/2,pageTop=top+(availableH-pageH)/2;
    const left=pageLeft+page.x*pageScale,upper=pageTop+page.y*pageScale;
    const aw=page.drawW*pageScale,ah=page.drawH*pageScale;
    ctx.fillStyle=page.background;ctx.fillRect(pageLeft,pageTop,pageW,pageH);
    ctx.strokeStyle='#8da38e';ctx.lineWidth=Math.max(1,w*.001);ctx.strokeRect(pageLeft,pageTop,pageW,pageH);
    ctx.save();ctx.beginPath();ctx.rect(pageLeft,pageTop,pageW,pageH);ctx.clip();
    ctx.imageSmoothingEnabled=true;ctx.drawImage(art,left,upper,aw,ah);ctx.restore();
    const finish=this.vectorFinish();
    if(finish){
      if(preview._finish!==finish){preview.innerHTML=finish.svg;preview._finish=finish;}
      preview.style.left=`${left/w*100}%`;preview.style.top=`${upper/h*100}%`;
      preview.style.width=`${aw/w*100}%`;preview.style.height=`${ah/h*100}%`;
      preview.hidden=false;
    }
    ctx.fillStyle='#a9c4a9';ctx.font = `${Math.max(10, w * .011)}px Consolas, monospace`;
    ctx.fillText(`${this.modelName.toUpperCase()}  ·  ${raster.layerCount} LAYER${raster.layerCount===1?'':'S'}  ·  ${rw} × ${rh} SOURCE SAMPLES  ·  ${page.w} × ${page.h} PAGE`, w * .035, h * .95);
  }
  contourSegments(raster, level) {
    const { values, w, h } = raster, lines = [];
    const interpolate = (x0,y0,x1,y1,v0,v1) => {
      const t = clamp((level - v0) / ((v1 - v0) || 1)); return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
    };
    for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
      const a = values[x+y*w], b = values[x+1+y*w], c = values[x+1+(y+1)*w], d = values[x+(y+1)*w];
      const hits = [];
      if ((a >= level) !== (b >= level)) hits.push(interpolate(x,y,x+1,y,a,b));
      if ((b >= level) !== (c >= level)) hits.push(interpolate(x+1,y,x+1,y+1,b,c));
      if ((c >= level) !== (d >= level)) hits.push(interpolate(x+1,y+1,x,y+1,c,d));
      if ((d >= level) !== (a >= level)) hits.push(interpolate(x,y+1,x,y,d,a));
      for (let i = 0; i + 1 < hits.length; i += 2) lines.push([hits[i],hits[i+1]]);
    }
    return lines;
  }
  drawContours(ctx, raster, left, top, sx, sy, palette) {
    for (const level of [.25,.5,.75]) {
      ctx.beginPath(); ctx.strokeStyle = rgb(1-level, palette); ctx.lineWidth = sx * .18;
      for (const [a,b] of this.contourSegments(raster,level)) {
        ctx.moveTo(left+a[0]*sx,top+a[1]*sy);ctx.lineTo(left+b[0]*sx,top+b[1]*sy);
      }
      ctx.stroke();
    }
  }
  toSVG() {
    const raster = this.raster(); if (!raster) return '';
    const page=this.pageLayout(raster),finish=this.vectorFinish();
    const paths=finish?.paths||exactRGBPaths(raster.pixels,raster.w,raster.h);
    const fills=finish?paths.map(vectorPathSVG).join(''):paths.map(({d,color})=>`<path d="${d}" fill="${color}"/>`).join('');
    const transform=`translate(${page.x.toFixed(3)} ${page.y.toFixed(3)}) scale(${page.scale.toFixed(6)})`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${page.w} ${page.h}" width="${page.w}" height="${page.h}" shape-rendering="${finish?'geometricPrecision':'crispEdges'}"><title>${finish?'Clean vector':'Exact-color'} CT composition — ${raster.layerCount} registered readings</title><rect width="${page.w}" height="${page.h}" fill="${page.background}"/><g transform="${transform}" data-vector-field="true" data-cells="${raster.w*raster.h}">${fills}</g></svg>`;
  }
  exportPNG() {
    const raster=this.raster();if(!this.model||!raster)return;
    const page=this.pageLayout(raster);
    const finish=this.vectorFinish();
    if(finish){
      const image=new Image(),url=URL.createObjectURL(new Blob([this.toSVG()],{type:'image/svg+xml'}));
      image.onload=()=>{const canvas=document.createElement('canvas');canvas.width=page.w;canvas.height=page.h;canvas.getContext('2d').drawImage(image,0,0);canvas.toBlob(blob=>save(blob,`${this.filename()}-clean-vector.png`),'image/png');URL.revokeObjectURL(url);};
      image.onerror=()=>URL.revokeObjectURL(url);image.src=url;return;
    }
    const canvas=document.createElement('canvas');canvas.width=page.w;canvas.height=page.h;
    const ctx=canvas.getContext('2d');ctx.fillStyle=page.background;ctx.fillRect(0,0,page.w,page.h);
    const art=document.createElement('canvas');art.width=raster.w;art.height=raster.h;
    art.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(raster.pixels),raster.w,raster.h),0,0);
    ctx.drawImage(art,page.x,page.y,page.drawW,page.drawH);
    canvas.toBlob(blob => save(blob, `${this.filename()}.png`), 'image/png');
  }
  exportSVG() {
    const svg = this.toSVG(); if (svg) save(new Blob([svg], { type: 'image/svg+xml' }), `${this.filename()}.svg`);
  }
  filename() { return (this.modelName || 'mesh').replace(/[^a-z0-9_-]+/gi,'-').slice(0,70) + '-high-definition-ct'; }
  removePoints() {
    if (!this.points) return;
    this.scene.remove(this.points); this.points.geometry.dispose(); this.points.material.dispose(); this.points = null;
  }
  rebuildPoints() {
    this.removePoints(); if (!this.result) return;
    const n = this.size, threshold = +$('lab-threshold').value / 100 * 255;
    const data = this.result.volume, palette = $('lab-palette').value;
    let count = 0; for (let i = 0; i < data.length; i++) if (data[i] >= threshold && data[i] > 0) count++;
    const stride = Math.max(1, Math.ceil(count / 85000));
    const positions = [], colors = []; let seen = 0;
    for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const value = data[x + n * (y + n * z)];
      if (value < threshold || !value || ++seen % stride) continue;
      positions.push((x + .5) * 4.4 / n - 2.2, (y + .5) * 4.4 / n - 2.2, (z + .5) * 4.4 / n - 2.2);
      const c = color(value / 255, palette), exposure = .16 + .50 * value / 255;
      colors.push(c[0]/255*exposure,c[1]/255*exposure,c[2]/255*exposure);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
    geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
    const material = new THREE.PointsMaterial({size:Math.max(1.5,2.8/n*64),sizeAttenuation:false,vertexColors:true,transparent:true,opacity:.22,depthWrite:false,blending:THREE.AdditiveBlending});
    this.points = new THREE.Points(geometry, material);this.points.visible = true;this.scene.add(this.points);
  }
  dispose() { this.worker?.terminate(); this.removePoints(); }
}
