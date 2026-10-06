import * as THREE from 'three';

// Names follow model axes: front looks from +Z; top has -Z at the top of the page.
export const ORTHO_VIEWS = [
  { id: 'front', label: 'Front', axis: '+Z', direction: [0, 0, 1], up: [0, 1, 0] },
  { id: 'back', label: 'Back', axis: '−Z', direction: [0, 0, -1], up: [0, 1, 0] },
  { id: 'left', label: 'Left', axis: '−X', direction: [-1, 0, 0], up: [0, 1, 0] },
  { id: 'right', label: 'Right', axis: '+X', direction: [1, 0, 0], up: [0, 1, 0] },
  { id: 'top', label: 'Top', axis: '+Y', direction: [0, 1, 0], up: [0, 0, -1] },
  { id: 'bottom', label: 'Bottom', axis: '−Y', direction: [0, -1, 0], up: [0, 0, 1] }
];

export class OrthographicView {
  constructor(canvas) {
    this.canvas = canvas;
    this.settings={view:'front',paper:'#f2f6f0'};this.cache=new Map();this.dirty=true;
    this.compositeTarget=new THREE.WebGLRenderTarget(1,1,{depthBuffer:false});
  }
  clearModel(){this.cache.clear();this.root=null;this.dirty=true;}
  setModel(root){this.clearModel();this.root=root;root.updateMatrixWorld(true);const box=new THREE.Box3().setFromObject(root);this.center=box.getCenter(new THREE.Vector3());this.span=Math.max(...box.getSize(new THREE.Vector3()).toArray())*1.12;}
  configure(settings){Object.assign(this.settings,settings);this.dirty=true;}
  resize(width, height, ratio) {
    const w = Math.max(1, Math.round(width * ratio)), h = Math.max(1, Math.round(height * ratio));
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w; this.canvas.height = h; this.dirty = true;
  }
  cameraFor(view) {
    const camera = new THREE.OrthographicCamera(-this.span / 2, this.span / 2, this.span / 2, -this.span / 2, .01, this.span * 5);
    camera.position.copy(this.center).addScaledVector(new THREE.Vector3(...view.direction), this.span * 2);
    camera.up.set(...view.up); camera.lookAt(this.center); camera.updateMatrixWorld(true);
    return camera;
  }
  capture(renderer, scene, view) {
    if (this.cache.has(view.id)) return this.cache.get(view.id);
    const columns=720,rows=720,target=this.compositeTarget;target.setSize(columns,rows);
    const pixels=new Uint8Array(columns*rows*4),previousTarget=renderer.getRenderTarget();
    try{this.scanCapture(this.cameraFor(view),target);renderer.readRenderTargetPixels(target,0,0,columns,rows,pixels);}
    finally{renderer.setRenderTarget(previousTarget);}
    const bounds = { minX: columns, maxX: -1, minY: rows, maxY: -1 };
    for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
      if (pixels[(y * columns + x) * 4 + 3] < 128) continue;
      bounds.minX = Math.min(bounds.minX, x); bounds.maxX = Math.max(bounds.maxX, x);
      bounds.minY = Math.min(bounds.minY, y); bounds.maxY = Math.max(bounds.maxY, y);
    }
    const frame={pixels,columns,rows,bounds};this.cache.set(view.id,frame);return frame;
  }
  render(renderer, scene, name) {
    if (!this.dirty || !this.root) return;
    const views = this.settings.view === 'all' ? ORTHO_VIEWS : ORTHO_VIEWS.filter(v => v.id === this.settings.view);
    // Static cameras: capture once per model/scan settings/view, then redraw from cached pixels.
    views.forEach(view => this.capture(renderer, scene, view));
    this.draw(this.canvas, name); this.dirty = false;
  }
  draw(canvas, name) {
    const ctx = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
    const all = this.settings.view === 'all', views = all ? ORTHO_VIEWS : ORTHO_VIEWS.filter(v => v.id === this.settings.view);
    const unit = Math.min(w, h), margin = unit * .055;
    const ratio = canvas === this.canvas ? canvas.width / Math.max(1, canvas.clientWidth) : 1;
    const fontSize = Math.max(11 * ratio, unit * .018), header = fontSize * 3.3, footer = fontSize * 2.5;
    const across = all ? (w / h < .85 ? 2 : 3) : 1, down = Math.ceil(views.length / across);
    const cellW = (w - margin * 2) / across, cellH = (h - margin * 2 - header - footer) / down;
    let sharedWidth = .01, sharedHeight = .01;
    if (all) for (const view of views) {
      const frame = this.cache.get(view.id); if (!frame || frame.bounds.maxX < 0) continue;
      const b = frame.bounds;
      sharedWidth = Math.max(sharedWidth, 2 * Math.max(b.maxX + 1 - frame.columns / 2, frame.columns / 2 - b.minX) / frame.columns);
      sharedHeight = Math.max(sharedHeight, 2 * Math.max(b.maxY + 1 - frame.rows / 2, frame.rows / 2 - b.minY) / frame.rows);
    }
    const paper=this.settings.paper;
    const dark=[1,3,5].reduce((sum,i)=>sum+parseInt(paper.slice(i,i+2),16),0)<360;
    const text = dark ? '#c0cec5' : '#52605e';
    ctx.fillStyle = paper; ctx.fillRect(0, 0, w, h);
    ctx.font = `${fontSize}px Consolas, monospace`; ctx.fillStyle = text; ctx.textAlign = 'left';
    ctx.fillText(all ? 'ORTHOGRAPHIC / SIX CT SCANS' : `ORTHOGRAPHIC / ${views[0].label.toUpperCase()} ${views[0].axis}`, margin, margin + fontSize);
    ctx.font = `${fontSize * .8}px Consolas, monospace`; ctx.fillStyle = text;
    const maxName = Math.max(16, Math.floor((w - margin * 2) / (fontSize * .49)));
    const caption = `CT / X-RAY / ${name}`;
    ctx.fillText(caption.length > maxName ? caption.slice(0, maxName - 1) + '…' : caption, margin, margin + fontSize * 2.65);
    views.forEach((view, index) => {
      const frame = this.cache.get(view.id); if (!frame || frame.bounds.maxX < 0) return;
      const x = margin + index % across * cellW, y = margin + header + Math.floor(index / across) * cellH;
      let size = Math.min(cellW * (all ? .91 : 1), cellH - (all ? fontSize * 2.5 : 0));
      if (all) size = Math.min(cellW * .9 / sharedWidth, (cellH - fontSize * 3) / sharedHeight);
      let left = x + (cellW - size) / 2, top = y + (cellH - size) / 2 + (all ? fontSize * .6 : 0);
      if (!all && frame.bounds.maxX >= 0) {
        const b = frame.bounds;
        size = .94 * Math.min(cellW * frame.columns / (b.maxX - b.minX + 1), cellH * frame.rows / (b.maxY - b.minY + 1));
        left = x + cellW / 2 - size * (b.minX + b.maxX + 1) / (2 * frame.columns);
        top = y + cellH / 2 - size * (frame.rows - (b.minY + b.maxY + 1) / 2) / frame.rows;
      }
      if (all) {
        ctx.fillStyle = text; ctx.font = `${fontSize * .85}px Consolas, monospace`;
        ctx.fillText(`${String(index + 1).padStart(2, '0')}  ${view.label.toUpperCase()} / ${view.axis}`, x + cellW * .05, y + fontSize);
      }
      ctx.save(); ctx.beginPath(); ctx.rect(x,y+(all?fontSize*1.5:0),cellW,Math.max(1,cellH-(all?fontSize*1.5:0)));ctx.clip();
      this.drawFrame(ctx, frame, left, top, size, size); ctx.restore();
    });
    ctx.fillStyle = text; ctx.font = `${fontSize * .75}px Consolas, monospace`;
    ctx.fillText('SIMULATED X-RAY  ·  '+(all?'SHARED SCALE':'FITTED VIEW'),margin,h-margin);
  }
  drawFrame(ctx,frame,left,top,width,height){
    const art=this.frameCanvas(frame);
    ctx.imageSmoothingEnabled=true;ctx.drawImage(art,left,top,width,height);
  }
  frameCanvas(frame){
    if(!frame.art){frame.art=document.createElement('canvas');frame.art.width=frame.columns;frame.art.height=frame.rows;
    const data=new Uint8ClampedArray(frame.pixels.length),stride=frame.columns*4;
    for(let y=0;y<frame.rows;y++)data.set(frame.pixels.subarray(y*stride,(y+1)*stride),(frame.rows-1-y)*stride);
    frame.art.getContext('2d').putImageData(new ImageData(data,frame.columns,frame.rows),0,0);}
    return frame.art;
  }
  detailedFrame(renderer,scene,viewId,angle=0){
    const base=ORTHO_VIEWS.find(item=>item.id===viewId)||ORTHO_VIEWS[0];
    const degrees=Math.max(-90,Math.min(90,Math.round(angle/5)*5));
    let view=base;
    if(degrees){
      const axis=new THREE.Vector3(base.id==='top'||base.id==='bottom'?1:0,base.id==='top'||base.id==='bottom'?0:1,0);
      const radians=THREE.MathUtils.degToRad(degrees);
      view={...base,id:`${base.id}@${degrees}`,direction:new THREE.Vector3(...base.direction).applyAxisAngle(axis,radians).toArray(),up:new THREE.Vector3(...base.up).applyAxisAngle(axis,radians).toArray()};
    }
    const frame=this.capture(renderer,scene,view);
    while(this.cache.size>18){const stale=[...this.cache.keys()].find(key=>key.includes('@'));if(!stale)break;this.cache.delete(stale);}
    this.frameCanvas(frame);
    return frame;
  }
  exportCanvas(name) {
    const canvas = document.createElement('canvas');
    canvas.width = this.settings.view === 'all' ? 3000 : 2048;
    canvas.height = this.settings.view === 'all' ? 2200 : 2048;
    this.draw(canvas, name); return canvas;
  }
  dispose() { this.clearModel(); this.compositeTarget.dispose(); }
}
