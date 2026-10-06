import { exactRGBPaths } from './exact-vector.js';
const $ = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const make = name => document.createElementNS(NS, name);
const escapeXML = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[character]));
const colorHex = value => {
  if(/^#[0-9a-f]{6}$/i.test(value))return value;
  const channels=String(value).match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/i);
  return channels?'#'+channels.slice(1).map(channel=>Number(channel).toString(16).padStart(2,'0')).join(''):'#1b9bd0';
};
const download = (blob, filename) => {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
};

export class VectorEditor {
  constructor(svg, lab) {
    this.svg = svg; this.lab = lab; this.layers = []; this.history = []; this.cursor = -1;
    this.selected = null; this.nextId = 1; this.bounds = {w:64,h:64};
    this.bind(); this.updateControls();
  }
  bind() {
    $('vector-build').onclick = () => this.build();
    $('vector-export').onclick = () => this.export();
    $('vector-layer').onchange = () => this.select(+$('vector-layer').value);
    for (const id of ['vector-color','vector-stroke-color','vector-opacity','vector-width','vector-scale','vector-rotation']) {
      $(id).addEventListener('input', () => {
        const layer = this.current(); if (!layer) return;
        if(id==='vector-color'){
          layer.color=$('vector-color').value;
          if(layer.kind==='field')layer.tint=true;
        }
        if(id==='vector-stroke-color')layer.strokeColor=$('vector-stroke-color').value;
        layer.opacity = +$('vector-opacity').value / 100;
        layer.width = +$('vector-width').value / 10;
        layer.scale = +$('vector-scale').value / 100;
        layer.rotation = +$('vector-rotation').value;
        this.render(); this.updateReadouts();
      });
      $(id).addEventListener('change', () => this.record());
    }
    $('vector-paint').addEventListener('change',()=>{const layer=this.current();if(!layer||layer.kind==='field'||layer.kind==='line')return;layer.mode=$('vector-paint').value;this.render();this.record();});
    $('vector-toggle').onclick = () => { const layer=this.current();if(!layer)return;layer.visible=!layer.visible;this.render();this.record();};
    $('vector-delete').onclick = () => { const i=this.layers.findIndex(layer=>layer.id===this.selected);if(i<0)return;this.layers.splice(i,1);this.selected=this.layers.at(Math.min(i,this.layers.length-1))?.id??null;this.render();this.record();};
    $('vector-up').onclick = () => this.moveLayer(1);
    $('vector-down').onclick = () => this.moveLayer(-1);
    $('vector-add').onclick = () => this.addShape($('vector-shape').value);
    $('vector-undo').onclick = () => this.restore(this.cursor-1);
    $('vector-redo').onclick = () => this.restore(this.cursor+1);
    $('vector-reset').onclick = () => this.restore(0,true);
    this.svg.addEventListener('pointerdown',event=>{
      const group=event.target.closest('[data-vector-id]');if(!group)return;
      const id=+group.dataset.vectorId;this.select(id);
      this.drag={id,start:this.point(event),x:this.current().x,y:this.current().y};
      this.svg.setPointerCapture(event.pointerId);
    });
    this.svg.addEventListener('pointermove',event=>{
      if(!this.drag)return;
      const layer=this.current();if(!layer||layer.id!==this.drag.id)return;
      const position=this.point(event);
      layer.x=this.drag.x+position.x-this.drag.start.x;
      layer.y=this.drag.y+position.y-this.drag.start.y;
      this.render();
    });
    this.svg.addEventListener('pointerup',()=>{if(!this.drag)return;this.drag=null;this.record();});
    this.svg.addEventListener('pointercancel',()=>{if(!this.drag)return;this.drag=null;this.record();});
  }
  point(event) {
    const point=this.svg.createSVGPoint();point.x=event.clientX;point.y=event.clientY;
    const mapped=point.matrixTransform(this.svg.getScreenCTM().inverse());
    return {x:mapped.x,y:mapped.y};
  }
  current() { return this.layers.find(layer=>layer.id===this.selected); }
  transform(layer){
    const edit=`translate(${layer.x} ${layer.y}) translate(${layer.cx} ${layer.cy}) rotate(${layer.rotation}) scale(${layer.scale}) translate(${-layer.cx} ${-layer.cy})`;
    return layer.baseScale?`${edit} translate(${layer.baseX} ${layer.baseY}) scale(${layer.baseScale})`:edit;
  }
  build() {
    const raster=this.lab.raster();if(!raster)return;
    const page=this.lab.pageLayout(raster);
    this.bounds={w:page.w,h:page.h};
    const base={baseX:page.x,baseY:page.y,baseScale:page.scale,sourceW:raster.w,sourceH:raster.h,
      cx:page.x+page.drawW/2,cy:page.y+page.drawH/2};
    const finish=this.lab.vectorFinish();this.clean=!!finish;this.pathData={};
    $('vector-editor-note').textContent=this.clean
      ?'Each traced color region is an editable vector layer. The clean finish simplifies color and fine noise; use the detail control before regenerating to change the result.'
      :'This exact-color SVG preserves every computed scan sample. Edits stay intact until you generate again.';
    if(finish){
      this.background=page.background;this.fieldSegments=[];this.fieldPreview='';
      this.layers=finish.paths.map((path,index)=>{
        const id=this.nextId++;this.pathData[id]=path.d;
        return {id,name:path.underlay?'Silhouette foundation':path.lineOnly?`Interior lines ${index+1}`:`Color region ${index+1} · ${path.cells} samples`,kind:'path',pathKey:id,
          color:path.color,strokeColor:path.strokeColor||path.color,
          mode:path.paint==='lines'?'stroke':path.paint==='both'?'both':'fill',
          width:path.lineWidth||.18,opacity:1,visible:true,
          x:0,y:0,scale:1,rotation:0,...base};
      });
    }else{
      this.background=page.background;
      this.fieldSegments=exactRGBPaths(raster.pixels,raster.w,raster.h);
      const preview=document.createElement('canvas');preview.width=raster.w;preview.height=raster.h;
      preview.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(raster.pixels),raster.w,raster.h),0,0);
      this.fieldPreview=preview.toDataURL('image/png');
      this.layers=[{
        id:this.nextId++,name:`Full-color reading · ${raster.w*raster.h} cells`,kind:'field',
        color:'#1b9bd0',strokeColor:'#1b9bd0',tint:false,mode:'fill',width:.18,opacity:1,visible:true,
        x:0,y:0,scale:1,rotation:0,...base
      }];
    }
    this.selected=this.layers[0]?.id??null;this.history=[];this.cursor=-1;
    this.render();this.record();
    $('vector-placeholder').hidden=true;$('vector-export').disabled=false;
    this.updateStatus();
  }
  addShape(kind) {
    if(!this.history.length)return;
    const {w,h}=this.bounds,cx=w/2,cy=h/2;
    const layer={id:this.nextId++,name:`${kind[0].toUpperCase()+kind.slice(1)} ${this.nextId-1}`,kind,
      color:'#1b9bd0',strokeColor:'#1b9bd0',mode:kind==='line'?'stroke':'fill',width:1,opacity:1,visible:true,
      x:0,y:0,scale:1,rotation:0,cx,cy};
    this.layers.push(layer);this.selected=layer.id;this.render();this.record();
  }
  moveLayer(direction) {
    const i=this.layers.findIndex(layer=>layer.id===this.selected),j=i+direction;
    if(i<0||j<0||j>=this.layers.length)return;
    [this.layers[i],this.layers[j]]=[this.layers[j],this.layers[i]];
    this.render();this.record();
  }
  select(id) { this.selected=id;this.render(); }
  render() {
    const svg=this.svg,{w,h}=this.bounds;
    svg.replaceChildren();svg.setAttribute('viewBox',`0 0 ${w} ${h}`);
    const background=make('rect');background.setAttribute('width',w);background.setAttribute('height',h);background.setAttribute('fill',this.background||'#e9efe7');svg.append(background);
    for(const layer of this.layers){
      const group=make('g');group.dataset.vectorId=layer.id;
      group.setAttribute('transform',this.transform(layer));
      group.style.cursor='move';group.style.display=layer.visible?'':'none';group.setAttribute('opacity',layer.opacity);
      const shape=make(layer.kind==='field'?(layer.tint?'rect':'image'):layer.kind==='path'?'path':layer.kind);
      if(layer.kind==='field'){
        shape.setAttribute('width',layer.sourceW||w);shape.setAttribute('height',layer.sourceH||h);
        if(layer.tint)shape.setAttribute('fill',layer.color);
        else shape.setAttribute('href',this.fieldPreview);
      }
      if(layer.kind==='path'){shape.setAttribute('d',this.pathData[layer.pathKey]||layer.d);if(this.clean)shape.setAttribute('fill-rule','evenodd');}
      if(layer.kind==='circle'){shape.setAttribute('cx',layer.cx);shape.setAttribute('cy',layer.cy);shape.setAttribute('r',Math.min(w,h)*.10);}
      if(layer.kind==='rect'){shape.setAttribute('x',layer.cx-w*.1);shape.setAttribute('y',layer.cy-h*.08);shape.setAttribute('width',w*.2);shape.setAttribute('height',h*.16);}
      if(layer.kind==='line'){shape.setAttribute('x1',layer.cx-w*.11);shape.setAttribute('y1',layer.cy-h*.08);shape.setAttribute('x2',layer.cx+w*.11);shape.setAttribute('y2',layer.cy+h*.08);}
      if(layer.kind!=='field')shape.setAttribute('fill',layer.mode==='stroke'?'none':layer.color);
      if(layer.kind!=='field')shape.setAttribute('stroke',layer.mode==='fill'?'none':layer.strokeColor||layer.color);
      if(layer.mode!=='fill')shape.setAttribute('stroke-width',layer.width);
      group.append(shape);svg.append(group);
      if(layer.id===this.selected&&layer.visible){
        const bounds=shape.getBBox();
        const box=make('rect');box.setAttribute('x',bounds.x-1);box.setAttribute('y',bounds.y-1);
        box.setAttribute('width',bounds.width+2);box.setAttribute('height',bounds.height+2);
        box.setAttribute('fill','none');box.setAttribute('stroke','#b0f470');box.setAttribute('stroke-width','.14');box.setAttribute('stroke-dasharray','.55 .4');
        box.setAttribute('pointer-events','none');group.append(box);
      }
    }
    this.updateControls();
    this.updateStatus();
  }
  updateStatus(){
    $('vector-status').textContent=this.layers.length?`${this.layers.length} editable layer${this.layers.length===1?'':'s'} · choose a layer or drag a shape.`:'No layers in the vector graphic.';
  }
  updateReadouts(){
    $('vector-opacity-value').textContent=`${$('vector-opacity').value}%`;
    $('vector-width-value').textContent=(+$('vector-width').value/10).toFixed(1);
    $('vector-scale-value').textContent=`${$('vector-scale').value}%`;
    $('vector-rotation-value').textContent=`${$('vector-rotation').value}°`;
  }
  updateControls(){
    const layer=this.current(),list=$('vector-layer');
    list.replaceChildren(...this.layers.map(item=>{const option=document.createElement('option');option.value=item.id;option.textContent=`${item.visible?'':'(hidden) '}${item.name}`;return option;}));
    if(layer){list.value=layer.id;$('vector-color').value=colorHex(layer.color);
      $('vector-opacity').value=Math.round(layer.opacity*100);$('vector-width').value=Math.round(layer.width*10);
      $('vector-scale').value=Math.round(layer.scale*100);$('vector-rotation').value=layer.rotation;
      $('vector-paint').value=layer.mode;
      $('vector-stroke-color').value=colorHex(layer.strokeColor||layer.color);
      $('vector-toggle').textContent=layer.visible?'Hide layer':'Show layer';}
    for(const id of ['vector-layer','vector-color','vector-opacity','vector-width','vector-scale','vector-rotation','vector-toggle','vector-up','vector-down','vector-delete','vector-add','vector-reset'])$(id).disabled=!layer;
    $('vector-color').disabled=!layer||layer.kind==='line'||layer.mode==='stroke';
    $('vector-paint').disabled=!layer||layer.kind==='field'||layer.kind==='line';
    $('vector-stroke-color').disabled=!layer||layer.kind==='field'||layer.mode==='fill';
    $('vector-width').disabled=!layer||layer.mode==='fill';
    $('vector-color-label').textContent=layer?.kind==='field'?'Color / replace palette':'Fill color';
    $('vector-undo').disabled=this.cursor<=0;$('vector-redo').disabled=this.cursor>=this.history.length-1;
    this.updateReadouts();
  }
  record(){
    if(!this.history.length&&!this.layers.length)return;
    this.history=this.history.slice(0,this.cursor+1);
    this.history.push(JSON.stringify({layers:this.layers,selected:this.selected,nextId:this.nextId}));
    this.cursor=this.history.length-1;this.updateControls();
  }
  restore(position,reset=false){
    if(!this.history.length)return;
    const index=reset?0:position;if(index<0||index>=this.history.length)return;
    const saved=JSON.parse(this.history[index]);this.layers=saved.layers;this.selected=saved.selected;this.nextId=saved.nextId;
    this.cursor=index;this.render();
    if(reset){this.history=this.history.slice(0,1);this.updateControls();}
  }
  svgString(){
    const {w,h}=this.bounds;
    const elements=this.layers.filter(layer=>layer.visible).map(layer=>{
      const transform=this.transform(layer);
      const common=`opacity="${layer.opacity}" transform="${transform}"`;
      const style=`fill="${layer.mode==='stroke'?'none':escapeXML(layer.color)}"${layer.mode==='fill'?'':` stroke="${escapeXML(layer.strokeColor||layer.color)}" stroke-width="${layer.width}"`}`;
      if(layer.kind==='field')return `<g id="layer-${layer.id}" data-name="${escapeXML(layer.name)}" ${common}>${this.fieldSegments.map(segment=>`<path d="${escapeXML(segment.d)}" fill="${escapeXML(layer.tint?layer.color:segment.color)}"/>`).join('')}</g>`;
      if(layer.kind==='path')return `<path id="layer-${layer.id}" data-name="${escapeXML(layer.name)}" d="${escapeXML(this.pathData[layer.pathKey]||layer.d)}" ${this.clean?'fill-rule="evenodd"':''} ${style} ${common}/>`;
      if(layer.kind==='circle')return `<circle id="layer-${layer.id}" cx="${layer.cx}" cy="${layer.cy}" r="${Math.min(w,h)*.10}" ${style} ${common}/>`;
      if(layer.kind==='rect')return `<rect id="layer-${layer.id}" x="${layer.cx-w*.1}" y="${layer.cy-h*.08}" width="${w*.2}" height="${h*.16}" ${style} ${common}/>`;
      return `<line id="layer-${layer.id}" x1="${layer.cx-w*.11}" y1="${layer.cy-h*.08}" x2="${layer.cx+w*.11}" y2="${layer.cy+h*.08}" ${style} ${common}/>`;
    }).join('');
    return `<svg xmlns="${NS}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" shape-rendering="${this.clean?'geometricPrecision':'crispEdges'}"><title>Editable high-definition CT composition</title><rect width="${w}" height="${h}" fill="${escapeXML(this.background)}"/>${elements}</svg>`;
  }
  export(){
    if(!this.layers.length)return;
    download(new Blob([this.svgString()],{type:'image/svg+xml'}),`${this.lab.filename()}-edited.svg`);
  }
  clear(){this.layers=[];this.history=[];this.cursor=-1;this.selected=null;this.fieldSegments=[];this.fieldPreview='';this.pathData={};this.clean=false;this.svg.replaceChildren();$('vector-placeholder').hidden=false;$('vector-export').disabled=true;$('vector-build').disabled=true;$('vector-status').textContent='Choose a 2D reading to begin.';this.updateControls();}
}
