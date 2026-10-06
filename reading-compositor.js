const SIDE = 720;
const STAGE = 1080;
const ORIGIN = (STAGE - SIDE) / 2;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export const READING_LABELS = {
  detail: 'Detailed CT', slice: 'Surface section', projection: 'Angle projection',
  sinogram: 'Multi-angle strips', stack: 'Overlapping scans', wrap: 'Wrapped scan',
  curve: 'Curved reformat', warp: 'Distorted projection', vector: 'Edge trace'
};

export function newReadingLayer(id, source = {}) {
  return {
    id, mode: source.mode || 'detail', view: source.view || 'front',
    angle: source.angle ?? 0, slice: source.slice ?? 50, effect: source.effect ?? 35,
    x: source.x ?? 0, y: source.y ?? 0, opacity: source.opacity ?? 100,
    scale: source.scale ?? 100, rotation: source.rotation ?? 0,
    blend: source.blend || 'normal', visible: source.visible ?? true
  };
}

export function moveReadingLayers(layers, selectedId, axis, nextValue, linked) {
  const selected = layers.find(layer => layer.id === selectedId);
  if (!selected || !['x','y'].includes(axis)) return;
  const next = clamp(Number(nextValue), -25, 25);
  const delta = next - selected[axis];
  if (linked) for (const layer of layers) layer[axis] = clamp(layer[axis] + delta, -25, 25);
  else selected[axis] = next;
}

function layerArt(layer, getFrame, cache) {
  const key = `${layer.mode}|${layer.view}|${layer.angle}|${layer.slice}|${layer.effect}`;
  if (cache.has(key)) return cache.get(key);
  const frame = offset => getFrame(layer.view, clamp(layer.angle + offset, -90, 90))?.art;
  const source = frame(0);
  if (!source) return null;
  const canvas = document.createElement('canvas'); canvas.width = SIDE; canvas.height = SIDE;
  const ctx = canvas.getContext('2d', { willReadFrequently: layer.mode === 'vector' });
  const strength = layer.effect / 100;
  if (layer.mode === 'slice') {
    ctx.globalAlpha = .16; ctx.drawImage(source, 0, 0); ctx.globalAlpha = 1;
    const center = layer.slice / 100 * SIDE, band = 24 + strength * 200;
    ctx.save(); ctx.beginPath(); ctx.rect(0, center - band / 2, SIDE, band); ctx.clip();
    ctx.drawImage(source, 0, 0); ctx.restore();
    ctx.fillStyle = 'rgba(255,116,28,.7)';
    ctx.fillRect(0, clamp(center-band/2,0,SIDE-1), SIDE, 1);
    ctx.fillRect(0, clamp(center+band/2,0,SIDE-1), SIDE, 1);
  } else if (layer.mode === 'projection') {
    ctx.drawImage(source, 0, 0);
    ctx.globalAlpha = .10 + strength * .18;
    ctx.globalCompositeOperation = 'screen';
    ctx.drawImage(frame(10) || source, 0, 0);
  } else if (layer.mode === 'sinogram') {
    const frames = [frame(-25), frame(-10), source, frame(10), frame(25)].map(item => item || source);
    const strip = Math.max(3, Math.round(7 + (1-strength) * 12));
    for (let y = 0, band = 0; y < SIDE; y += strip, band++) {
      const src = frames[band % frames.length];
      ctx.drawImage(src, 0, y, SIDE, Math.min(strip,SIDE-y), 0, y, SIDE, Math.min(strip,SIDE-y));
    }
  } else if (layer.mode === 'stack') {
    const distance = Math.round(2 + strength * 22);
    ctx.globalAlpha = .45; ctx.drawImage(frame(-15) || source, -distance, 0);
    ctx.globalAlpha = .72; ctx.drawImage(source, 0, 0);
    ctx.globalAlpha = .45; ctx.drawImage(frame(15) || source, distance, 0);
  } else if (layer.mode === 'wrap') {
    const amplitude = 8 + strength * 90;
    for (let y = 0; y < SIDE; y += 2) {
      const shift = Math.round(Math.sin(y / SIDE * Math.PI * 2) * amplitude);
      ctx.drawImage(source, 0, y, SIDE, 2, shift, y, SIDE, 2);
    }
  } else if (layer.mode === 'curve') {
    const amplitude = 8 + strength * 90;
    for (let x = 0; x < SIDE; x += 2) {
      const shift = Math.round(Math.sin(x / SIDE * Math.PI * 2) * amplitude);
      ctx.drawImage(source, x, 0, 2, SIDE, x, shift, 2, SIDE);
    }
  } else if (layer.mode === 'warp') {
    const amplitude = 5 + strength * 52;
    for (let y = 0; y < SIDE; y += 2) {
      const shift = Math.round(Math.sin(y * .055) * amplitude + Math.sin(y * .17) * amplitude * .2);
      ctx.drawImage(source, 0, y, SIDE, 2, shift, y, SIDE, 2);
    }
  } else {
    ctx.drawImage(source, 0, 0);
    if (layer.mode === 'vector') {
      const image = ctx.getImageData(0, 0, SIDE, SIDE), data = image.data;
      const outline = new Uint8ClampedArray(data);
      const threshold = 28 + strength * 95;
      for (let y = 1; y < SIDE - 1; y++) for (let x = 1; x < SIDE - 1; x++) {
        const at = (y * SIDE + x) * 4, right = at + 4, below = at + SIDE * 4;
        if (data[at + 3] < 16) continue;
        const edge = Math.max(
          Math.abs(data[at]-data[right])+Math.abs(data[at+1]-data[right+1])+Math.abs(data[at+2]-data[right+2]),
          Math.abs(data[at]-data[below])+Math.abs(data[at+1]-data[below+1])+Math.abs(data[at+2]-data[below+2])
        );
        if (edge > threshold) { outline[at]=3; outline[at+1]=34; outline[at+2]=91; outline[at+3]=255; }
      }
      ctx.putImageData(new ImageData(outline, SIDE, SIDE), 0, 0);
    }
  }
  cache.set(key, canvas);
  return canvas;
}

export function composeReadings(layers, getFrame, paper, palette, recolor, layerCache) {
  const stage = document.createElement('canvas'); stage.width = STAGE; stage.height = STAGE;
  const ctx = stage.getContext('2d', { willReadFrequently: true });
  let visible = 0;
  for (const layer of layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    const art = layerArt(layer, getFrame, layerCache);
    if (!art) continue;
    visible++;
    ctx.save();
    ctx.globalAlpha = layer.opacity / 100;
    ctx.globalCompositeOperation = layer.blend === 'normal' ? 'source-over' : layer.blend;
    ctx.translate(STAGE / 2 + layer.x / 100 * SIDE, STAGE / 2 + layer.y / 100 * SIDE);
    ctx.rotate(layer.rotation * Math.PI / 180);
    ctx.scale(layer.scale / 100, layer.scale / 100);
    ctx.drawImage(art, -SIDE / 2, -SIDE / 2);
    ctx.restore();
  }
  if (!visible) return null;
  const stageImage = ctx.getImageData(0, 0, STAGE, STAGE), stagePixels=stageImage.data;
  if(palette!=='scanner'){
    for(let i=0;i<stagePixels.length;i+=4){
      if(stagePixels[i+3]<1)continue;
      const luminance=(stagePixels[i]*.2126+stagePixels[i+1]*.7152+stagePixels[i+2]*.0722)/255;
      const mapped=recolor(luminance,palette);
      stagePixels[i]=mapped[0];stagePixels[i+1]=mapped[1];stagePixels[i+2]=mapped[2];
    }
    ctx.putImageData(stageImage,0,0);
  }
  let minX=STAGE,minY=STAGE,maxX=-1,maxY=-1;
  for (let y=0;y<STAGE;y++) for(let x=0;x<STAGE;x++){
    if(stagePixels[(y*STAGE+x)*4+3]<8)continue;
    if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;
  }
  if(maxX<0)return null;
  const pad=24,sx=clamp(minX-pad,0,STAGE),sy=clamp(minY-pad,0,STAGE);
  const ex=clamp(maxX+1+pad,0,STAGE),ey=clamp(maxY+1+pad,0,STAGE);
  const w=ex-sx,h=ey-sy;
  const out=document.createElement('canvas');out.width=w;out.height=h;
  const outCtx=out.getContext('2d',{willReadFrequently:true});
  outCtx.fillStyle=paper;outCtx.fillRect(0,0,w,h);
  outCtx.drawImage(stage,sx,sy,w,h,0,0,w,h);
  const pixels=outCtx.getImageData(0,0,w,h).data;
  return {pixels,w,h,mode:'composite',layerCount:visible};
}
