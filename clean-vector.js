// Convert the finished scan into editable contours, planar rectangles, or curved patches.
// No bitmap or image element is embedded in the returned SVG.
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function adaptivePalette(pixels, target) {
  const bins = new Map();
  for (let i = 0; i < pixels.length; i += 16) {
    const r=pixels[i],g=pixels[i+1],b=pixels[i+2];
    const key=(r>>3)<<10|(g>>3)<<5|(b>>3);
    const entry=bins.get(key)||{n:0,r:0,g:0,b:0};
    entry.n++;entry.r+=r;entry.g+=g;entry.b+=b;bins.set(key,entry);
  }
  const entries=[...bins.values()].map(entry=>({
    n:entry.n,r:entry.r/entry.n,g:entry.g/entry.n,b:entry.b/entry.n
  }));
  if(!entries.length)return [[240,244,239]];
  const boxes=[entries];
  while(boxes.length<target){
    let best=-1,bestScore=0,bestChannel='r';
    for(let i=0;i<boxes.length;i++){
      const box=boxes[i];if(box.length<2)continue;
      const ranges={r:0,g:0,b:0};
      for(const channel of ['r','g','b']){
        let min=255,max=0;for(const point of box){min=Math.min(min,point[channel]);max=Math.max(max,point[channel]);}
        ranges[channel]=max-min;
      }
      const channel=Object.keys(ranges).sort((a,b)=>ranges[b]-ranges[a])[0];
      const weight=box.reduce((sum,point)=>sum+point.n,0);
      const score=ranges[channel]*Math.sqrt(weight);
      if(score>bestScore){best=i;bestScore=score;bestChannel=channel;}
    }
    if(best<0||bestScore<1)break;
    const box=boxes.splice(best,1)[0].sort((a,b)=>a[bestChannel]-b[bestChannel]);
    const half=box.reduce((sum,point)=>sum+point.n,0)/2;
    let weight=0,cut=1;
    for(let i=0;i<box.length-1;i++){weight+=box[i].n;if(weight>=half){cut=i+1;break;}}
    boxes.push(box.slice(0,cut),box.slice(cut));
  }
  return boxes.map(box=>{
    const n=box.reduce((sum,point)=>sum+point.n,0);
    return ['r','g','b'].map(channel=>Math.round(box.reduce((sum,point)=>sum+point[channel]*point.n,0)/n));
  });
}

function classify(pixels,w,h,palette,detail){
  const labels=new Uint8Array(w*h);
  for(let p=0;p<labels.length;p++){
    const i=p*4,r=pixels[i],g=pixels[i+1],b=pixels[i+2];
    let best=Infinity,index=0;
    for(let k=0;k<palette.length;k++){
      const c=palette[k],dr=r-c[0],dg=g-c[1],db=b-c[2];
      const distance=dr*dr*.8+dg*dg+db*db*.95;
      if(distance<best){best=distance;index=k;}
    }
    labels[p]=index;
  }
  // Remove isolated scanner flecks without softening whole edges.
  const passes=detail<35?2:1;
  for(let pass=0;pass<passes;pass++){
    const next=new Uint8Array(labels);
    for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){
      const i=y*w+x,own=labels[i],counts=new Uint8Array(palette.length);
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)counts[labels[i+dy*w+dx]]++;
      if(counts[own]>=3)continue;
      let replacement=own,count=counts[own];
      for(let k=0;k<counts.length;k++)if(counts[k]>count){count=counts[k];replacement=k;}
      if(count>=4)next[i]=replacement;
    }
    labels.set(next);
  }
  return labels;
}

function mergeSmallComponents(labels,w,h,backgroundIndex,cutoff,mode,paletteSize){
  if(cutoff<2)return 0;
  const queue=new Int32Array(labels.length);
  let merged=0;
  for(let pass=0;pass<2;pass++){
    const seen=new Uint8Array(labels.length);
    let changed=0;
    for(let seed=0;seed<labels.length;seed++){
      if(seen[seed])continue;
      const color=labels[seed],neighbors=new Uint32Array(paletteSize);
      let head=0,tail=1,touchesBorder=false;queue[0]=seed;seen[seed]=1;
      while(head<tail){
        const i=queue[head++],x=i%w,y=Math.floor(i/w);
        if(x===0||x===w-1||y===0||y===h-1)touchesBorder=true;
        for(const next of [x>0?i-1:-1,x<w-1?i+1:-1,y>0?i-w:-1,y<h-1?i+w:-1]){
          if(next<0)continue;
          if(labels[next]===color){if(!seen[next]){seen[next]=1;queue[tail++]=next;}}
          else neighbors[labels[next]]++;
        }
      }
      if(tail>=cutoff||(color===backgroundIndex&&touchesBorder))continue;
      let target=backgroundIndex;
      if(mode==='merge'){
        let contacts=0;
        for(let k=0;k<neighbors.length;k++)if(k!==color&&neighbors[k]>contacts){contacts=neighbors[k];target=k;}
        if(!contacts)continue;
      }
      if(target===color)continue;
      for(let i=0;i<tail;i++)labels[queue[i]]=target;
      changed++;merged++;
    }
    if(!changed)break;
  }
  return merged;
}

function simplify(points,tolerance){
  if(points.length<=5)return points;
  const corners=[];
  for(let i=0;i<points.length;i++){
    const a=points[(i+points.length-1)%points.length],b=points[i],c=points[(i+1)%points.length];
    if((b[0]-a[0])*(c[1]-b[1])!==(b[1]-a[1])*(c[0]-b[0]))corners.push(b);
  }
  if(corners.length<=5)return corners;
  // Local point-to-chord simplification preserves the loop, including holes.
  let changed=true;
  while(changed){
    changed=false;
    for(let i=0;i<corners.length&&corners.length>5;i++){
      const a=corners[(i+corners.length-1)%corners.length],b=corners[i],c=corners[(i+1)%corners.length];
      const dx=c[0]-a[0],dy=c[1]-a[1],length=Math.hypot(dx,dy)||1;
      const distance=Math.abs((b[0]-a[0])*dy-(b[1]-a[1])*dx)/length;
      if(distance<tolerance){corners.splice(i,1);changed=true;i--;}
    }
  }
  return corners;
}

function contourPath(points,detail,edgeReduction,geometry='contour',structure=0){
  const base=detail<35?1.5:detail<75?.9:.35;
  const patchTolerance=Math.pow(structure/100,1.5)*(geometry==='curved'?15:4);
  const corners=simplify(points,base+Math.pow(edgeReduction/100,1.8)*8+patchTolerance);
  if(corners.length<3)return {d:'',edges:0};
  if(geometry!=='curved'&&detail>=85&&edgeReduction<20)return {d:`M${corners.map(p=>`${p[0]} ${p[1]}`).join('L')}Z`,edges:corners.length};
  const midpoint=(a,b)=>`${((a[0]+b[0])/2).toFixed(1)} ${((a[1]+b[1])/2).toFixed(1)}`;
  let d=`M${midpoint(corners.at(-1),corners[0])}`;
  for(let i=0;i<corners.length;i++)d+=`Q${corners[i][0]} ${corners[i][1]} ${midpoint(corners[i],corners[(i+1)%corners.length])}`;
  return {d:d+'Z',edges:corners.length};
}

function traceColor(labels,w,h,color,detail,edgeReduction,geometry='contour',structure=0){
  const edges=new Map(),stride=w+1;
  const add=(start,end,dir)=>{const list=edges.get(start)||[];list.push({end,dir});edges.set(start,list);};
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const i=y*w+x;if(labels[i]!==color)continue;
    const tl=y*stride+x,tr=tl+1,bl=tl+stride,br=bl+1;
    if(y===0||labels[i-w]!==color)add(tl,tr,0);
    if(x===w-1||labels[i+1]!==color)add(tr,br,1);
    if(y===h-1||labels[i+w]!==color)add(br,bl,2);
    if(x===0||labels[i-1]!==color)add(bl,tl,3);
  }
  const commands=[];let regions=0,edgeCount=0;
  while(edges.size){
    const start=edges.keys().next().value,points=[];
    let at=start,previous=0,guard=0;
    do{
      points.push([at%stride,Math.floor(at/stride)]);
      const options=edges.get(at);if(!options?.length)break;
      let best=0,score=5;
      for(let i=0;i<options.length;i++){
        const turn=(options[i].dir-previous+4)%4;
        const rank=turn===1?0:turn===0?1:turn===3?2:3;
        if(rank<score){best=i;score=rank;}
      }
      const edge=options.splice(best,1)[0];if(!options.length)edges.delete(at);
      previous=edge.dir;at=edge.end;
    }while(at!==start&&++guard<w*h*4);
    if(at===start&&points.length>3){
      const contour=contourPath(points,detail,edgeReduction,geometry,structure);
      if(contour.d){commands.push(contour.d);regions++;edgeCount+=contour.edges;}
    }
  }
  return {d:commands.join(''),regions,edges:edgeCount};
}

function rectilinearGrid(labels,w,h,paletteSize,structure){
  const cell=Math.max(2,Math.round(2+Math.pow(structure/100,1.3)*30));
  const cols=Math.ceil(w/cell),rows=Math.ceil(h/cell),grid=new Uint8Array(cols*rows);
  const tally=new Uint32Array(paletteSize);
  for(let gy=0;gy<rows;gy++)for(let gx=0;gx<cols;gx++){
    tally.fill(0);
    for(let y=gy*cell;y<Math.min(h,(gy+1)*cell);y++)
      for(let x=gx*cell;x<Math.min(w,(gx+1)*cell);x++)tally[labels[y*w+x]]++;
    let best=0;for(let k=1;k<paletteSize;k++)if(tally[k]>tally[best])best=k;
    grid[gy*cols+gx]=best;
  }
  return {grid,cols,rows,cell};
}

function traceRectangles(tiles,w,h,color){
  const {grid,cols,rows,cell}=tiles,commands=[];let regions=0;
  let active=new Map();
  const finish=rect=>{
    const x=rect.start*cell,x2=Math.min(w,rect.end*cell),y=rect.top*cell,y2=Math.min(h,rect.bottom*cell);
    commands.push(`M${x} ${y}H${x2}V${y2}H${x}Z`);regions++;
  };
  for(let gy=0;gy<=rows;gy++){
    const next=new Map();
    if(gy<rows)for(let gx=0;gx<cols;){
      if(grid[gy*cols+gx]!==color){gx++;continue;}
      const start=gx;while(gx<cols&&grid[gy*cols+gx]===color)gx++;
      const key=`${start}:${gx}`,rect=active.get(key)||{start,end:gx,top:gy,bottom:gy};
      rect.bottom=gy+1;next.set(key,rect);
    }
    for(const [key,rect] of active)if(!next.has(key))finish(rect);
    active=next;
  }
  return {d:commands.join(''),regions,edges:regions*4};
}

function hatchLines(labels,w,h,color,density,tiles){
  if(density<=0)return {d:'',segments:0};
  const spacing=Math.max(4,Math.round(46-density*.42));
  const sample=tiles
    ?(x,y)=>tiles.grid[Math.floor(y/tiles.cell)*tiles.cols+Math.floor(x/tiles.cell)]
    :(x,y)=>labels[y*w+x];
  const commands=[];let segments=0;
  for(let x=Math.floor(spacing/2);x<w;x+=spacing){
    let start=-1;
    for(let y=0;y<=h;y++){
      const inside=y<h&&sample(x,y)===color;
      if(inside&&start<0)start=y;
      if(!inside&&start>=0){
        if(y-start>=Math.max(3,Math.round(spacing*.22))){commands.push(`M${x} ${start}V${y}`);segments++;}
        start=-1;
      }
    }
  }
  return {d:commands.join(''),segments};
}

export function vectorPathSVG(path){
  const paint=path.paint||'fill';
  const fill=paint==='lines'?'none':path.color;
  const stroke=paint==='fill'?'':` stroke="${path.strokeColor||path.color}" stroke-width="${path.lineWidth||1}" stroke-linecap="round" stroke-linejoin="round"`;
  return `<path d="${path.d}" fill="${fill}" fill-rule="evenodd"${stroke}/>`;
}

export function cleanVector(pixels,w,h,options=65){
  if(w<1||h<1||pixels.length!==w*h*4)throw new Error('Invalid vector source image.');
  const settings=typeof options==='number'?{detail:options}:options;
  const detail=clamp(Number(settings.detail)||0,0,100);
  const minRegion=clamp(Number(settings.minRegion)||0,0,100);
  const edgeReduction=clamp(Number(settings.edgeReduction)||0,0,100);
  const structure=clamp(Number(settings.structure)||0,0,100);
  const geometry=['rectilinear','curved'].includes(settings.geometry)?settings.geometry:'contour';
  const paint=['lines','both'].includes(settings.paint)?settings.paint:'fill';
  const lineWidth=clamp(Number(settings.lineWidth)||1,0.2,4);
  const lineDensity=clamp(Number(settings.lineDensity)||0,0,100);
  const lineColor=/^#[0-9a-f]{6}$/i.test(settings.lineColor||'')?settings.lineColor:'#17232d';
  const smallRegionMode=settings.smallRegionMode==='remove'?'remove':'merge';
  // Keep the cutoff proportional to source area, but reserve the strongest
  // simplification for the end of the slider so fine mesh markings survive.
  const cutoff=minRegion?Math.max(2,Math.round((minRegion/100)**2*w*h*.0015)):0;
  const palette=adaptivePalette(pixels,Math.round(10+detail*.28));
  const labels=classify(pixels,w,h,palette,detail);
  // The canvas border is the scan paper, even when the mesh covers more area.
  const borderCounts=new Uint32Array(palette.length);
  for(let x=0;x<w;x++){borderCounts[labels[x]]++;borderCounts[labels[(h-1)*w+x]]++;}
  for(let y=0;y<h;y++){borderCounts[labels[y*w]]++;borderCounts[labels[y*w+w-1]]++;}
  const backgroundIndex=borderCounts.indexOf(Math.max(...borderCounts));
  const background=palette[backgroundIndex];
  let mergedComponents=mergeSmallComponents(labels,w,h,backgroundIndex,cutoff,smallRegionMode,palette.length);
  // Broad curved surfaces need coherent color regions before contour fitting.
  // This follows the structure slider independently of the optional fleck filter.
  const patchCutoff=geometry==='curved'?Math.round(Math.pow(structure/100,2)*w*h*.0008):0;
  if(patchCutoff>cutoff)mergedComponents+=mergeSmallComponents(labels,w,h,backgroundIndex,patchCutoff,'merge',palette.length);
  const tiles=geometry==='rectilinear'?rectilinearGrid(labels,w,h,palette.length,structure):null;
  const counts=new Uint32Array(palette.length);
  if(tiles){
    for(let gy=0;gy<tiles.rows;gy++)for(let gx=0;gx<tiles.cols;gx++)
      counts[tiles.grid[gy*tiles.cols+gx]]+=(Math.min(w,(gx+1)*tiles.cell)-gx*tiles.cell)*(Math.min(h,(gy+1)*tiles.cell)-gy*tiles.cell);
  }else for(const label of labels)counts[label]++;
  const fill=color=>`rgb(${color.join(',')})`;
  const paths=[];
  // A traced silhouette supports every softened color region. It prevents
  // hairline paper gaps where two independently smoothed shapes meet.
  const mask=new Uint8Array(labels.length);
  let baseIndex=-1,baseCount=0;
  for(let k=0;k<counts.length;k++)if(k!==backgroundIndex&&counts[k]>baseCount){baseCount=counts[k];baseIndex=k;}
  if(baseIndex>=0&&paint!=='lines'&&geometry!=='rectilinear'){
    for(let i=0;i<labels.length;i++)mask[i]=labels[i]===backgroundIndex?0:1;
    const trace=traceColor(mask,w,h,1,90,0);
    if(trace.d)paths.push({d:trace.d,color:fill(palette[baseIndex]),cells:baseCount,underlay:true});
  }
  const colorPaths=[],hatches=[];let regions=0,edges=0,lineSegments=0;
  for(let k=0;k<palette.length;k++){
    if(!counts[k]||palette[k]===background)continue;
    const trace=tiles?traceRectangles(tiles,w,h,k):traceColor(labels,w,h,k,detail,edgeReduction,geometry,structure);
    if(trace.d){colorPaths.push({d:trace.d,color:fill(palette[k]),cells:counts[k],paint,strokeColor:lineColor,lineWidth});regions+=trace.regions;edges+=trace.edges;}
    if(paint!=='fill'){
      const hatch=hatchLines(labels,w,h,k,lineDensity,tiles);
      if(hatch.d){hatches.push({d:hatch.d,color:lineColor,cells:counts[k],paint:'lines',strokeColor:lineColor,lineWidth,lineOnly:true});lineSegments+=hatch.segments;}
    }
  }
  colorPaths.sort((a,b)=>b.cells-a.cells);
  paths.push(...colorPaths,...hatches);
  const backgroundColor=settings.background||fill(background);
  const shapes=paths.map(vectorPathSVG).join('');
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><title>Clean vector CT composition</title><rect width="${w}" height="${h}" fill="${backgroundColor}"/>${shapes}</svg>`;
  return {w,h,background:backgroundColor,paths,svg,paletteSize:palette.length,detail,geometry,paint,
    stats:{regions,edges,lineSegments,mergedComponents,cutoff,smallRegionMode}};
}
