import * as THREE from 'three';
import { ORTHO_VIEWS } from './orthographic-view.js';

// Reuse the 2D composition and contour pipeline on perspective mesh captures.
// Vector processing runs off the UI thread; orbit input remains responsive.
export class Linked3DView {
  constructor(renderer,scene,lab,capture) {
    Object.assign(this,{renderer,scene,lab,capture});
    this.canvas=document.getElementById('linked-3d-art');
    this.vector=document.getElementById('linked-3d-vector');
    this.status=document.getElementById('linked-3d-status');
    this.target=new THREE.WebGLRenderTarget(720,720,{depthBuffer:false});
    this.worker=new Worker(new URL('./linked-3d-worker.js',import.meta.url),{type:'module'});
    this.worker.onmessage=({data})=>{
      const job=this.job;this.busy=false;this.job=null;
      if(!job||data.revision!==this.revision)return;
      if(data.error){this.status.textContent='Vector preview unavailable';console.error(data.error);this.key='';return;}
      this.draw(job.raster,job.page,data.svg);
      this.status.textContent='Same controls · vector finish';
    };
    this.worker.onerror=()=>{this.busy=false;this.status.textContent='Vector preview unavailable';};
    this.revision=0;this.lastCapture=0;this.key='';
  }
  invalidate(){this.revision++;this.key='';}
  resize(width,height,ratio) {
    const w=Math.max(1,Math.round(width*Math.min(ratio,1.5))),h=Math.max(1,Math.round(height*Math.min(ratio,1.5)));
    if(this.canvas.width===w&&this.canvas.height===h)return;
    this.canvas.width=w;this.canvas.height=h;
    this.invalidate();
  }
  frame(viewId,angle,camera,target,cache) {
    const key=`${viewId}|${angle}`;
    if(cache.has(key))return cache.get(key);
    const view=ORTHO_VIEWS.find(item=>item.id===viewId)||ORTHO_VIEWS[0];
    const direction=new THREE.Vector3(...view.direction),up=new THREE.Vector3(...view.up);
    const axis=new THREE.Vector3(viewId==='top'||viewId==='bottom'?1:0,viewId==='top'||viewId==='bottom'?0:1,0);
    direction.applyAxisAngle(axis,THREE.MathUtils.degToRad(angle)).applyQuaternion(camera.quaternion);
    up.applyAxisAngle(axis,THREE.MathUtils.degToRad(angle)).applyQuaternion(camera.quaternion);
    const viewCamera=camera.clone();viewCamera.aspect=1;
    viewCamera.fov=THREE.MathUtils.radToDeg(2*Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov)/2)*Math.min(1,camera.aspect)));
    viewCamera.position.copy(target).addScaledVector(direction,this.fitDistance||camera.position.distanceTo(target));
    viewCamera.up.copy(up);viewCamera.lookAt(target);viewCamera.updateProjectionMatrix();viewCamera.updateMatrixWorld(true);
    const previous=this.renderer.getRenderTarget(),pixels=new Uint8Array(720*720*4);
    try {this.capture(viewCamera,this.target);this.renderer.readRenderTargetPixels(this.target,0,0,720,720,pixels);}
    finally {this.renderer.setRenderTarget(previous);}
    const art=document.createElement('canvas');art.width=720;art.height=720;
    const image=new Uint8ClampedArray(pixels.length),stride=720*4;
    for(let y=0;y<720;y++)image.set(pixels.subarray(y*stride,(y+1)*stride),(719-y)*stride);
    art.getContext('2d').putImageData(new ImageData(image,720,720),0,0);
    const result={art};cache.set(key,result);return result;
  }
  update(camera,target,scanState,time=performance.now()) {
    if(!this.lab.model||document.getElementById('preview-3d').hidden)return;
    const appearance=this.lab.appearanceKey()+JSON.stringify(scanState);
    if(appearance!==this.appearance){this.appearance=appearance;this.invalidate();}
    camera.updateMatrixWorld(true);
    const key=appearance+camera.matrixWorld.elements.map(n=>n.toFixed(4)).join(',')+target.toArray().join(',');
    if(key===this.key||this.busy)return;
    const finished=document.getElementById('lab-vector-finish').checked;
    if(time-this.lastCapture<(finished?180:90))return;
    this.lastCapture=time;this.key=key;
    const frames=new Map(),layerCache=new Map();
    const raster=this.lab.composeView((view,angle)=>this.frame(view,angle,camera,target,frames),layerCache);
    if(!raster){this.draw(null);this.status.textContent='No visible reading layers';return;}
    const page=this.lab.pageLayout(raster);
    page.zoom=(this.fitDistance||camera.position.distanceTo(target))/camera.position.distanceTo(target);
    if(!finished){this.draw(raster,page);this.status.textContent='Same controls · CT graphic';return;}
    this.busy=true;this.status.textContent='Updating vector finish…';
    this.job={raster,page};
    const pixels=new Uint8ClampedArray(raster.pixels);
    this.worker.postMessage({revision:this.revision,pixels,w:raster.w,h:raster.h,settings:this.lab.vectorSettings()},[pixels.buffer]);
  }
  draw(raster,page,svg='') {
    const ctx=this.canvas.getContext('2d'),w=this.canvas.width,h=this.canvas.height;
    ctx.fillStyle='#f6f8fa';ctx.fillRect(0,0,w,h);this.vector.hidden=true;
    if(!raster)return;
    const margin=Math.min(w,h)*.035,scale=Math.min((w-2*margin)/page.w,(h-2*margin)/page.h);
    const pageW=page.w*scale,pageH=page.h*scale,pageX=(w-pageW)/2,pageY=(h-pageH)/2;
    const zoom=page.zoom||1,aw=page.drawW*scale*zoom,ah=page.drawH*scale*zoom;
    const x=pageX+page.x*scale+(page.drawW*scale-aw)/2,y=pageY+page.y*scale+(page.drawH*scale-ah)/2;
    ctx.fillStyle=page.background;ctx.fillRect(pageX,pageY,pageW,pageH);
    ctx.strokeStyle='#cbd5df';ctx.lineWidth=1;ctx.strokeRect(pageX,pageY,pageW,pageH);
    if(svg){
      this.vector.innerHTML=svg;
      this.vector.style.left=`${x/w*100}%`;this.vector.style.top=`${y/h*100}%`;
      this.vector.style.width=`${aw/w*100}%`;this.vector.style.height=`${ah/h*100}%`;
      const clip=[Math.max(0,pageY-y),Math.max(0,x+aw-pageX-pageW),Math.max(0,y+ah-pageY-pageH),Math.max(0,pageX-x)];
      this.vector.style.clipPath=`inset(${clip.map((n,i)=>`${n/(i%2?aw:ah)*100}%`).join(' ')})`;
      this.vector.hidden=false;
    }else{
      const art=document.createElement('canvas');art.width=raster.w;art.height=raster.h;
      art.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(raster.pixels),raster.w,raster.h),0,0);
      ctx.save();ctx.beginPath();ctx.rect(pageX,pageY,pageW,pageH);ctx.clip();ctx.drawImage(art,x,y,aw,ah);ctx.restore();
    }
  }
}
