import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { CTView } from './ct-view.js';
import { OrthographicView, ORTHO_VIEWS } from './orthographic-view.js';
import { TomographyLab } from './tomography-lab.js';
import { VectorEditor } from './vector-editor.js';

const $ = id => document.getElementById(id);
const scanDefaults = { density:1.1, edges:.4, palette:'color', slice:false, axis:'y', position:50, thickness:15, sweep:false };
const scanState = {...scanDefaults};
let renderer,scene,camera,orbit,volumeRenderer,volumeScene,volumeCamera,volumeOrbit,ctView,orthographicView,lab,vectorEditor,postScene,postCamera,postMaterial,root;
let width=1,height=1,sheetSignature='',scanDirection=1,lastOrthoFrame=0;
let currentName='',triangleCount=0,textureCount=0,activeImport=null,lastFrame=0,frameCount=0,fpsTime=0;
let toastTimer,renderingFailed=false;
function toast(message, error = false) {
  $('toast').textContent = message; $('toast').classList.toggle('error', error); $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, error ? 9500 : 4000);
}
function progress(percent, message) {
  $('progress').value = percent; $('loading-message').textContent = message;
}
function setLoading(active, title = 'Reading your model') {
  $('loading').hidden = !active; $('loading-title').textContent = title;
  updateExportButtons(active);
}
function updateExportButtons(loading = !$('loading').hidden) {
  $('export-png').disabled=loading||!root||renderingFailed;
  $('export-ortho').disabled=loading||!root||renderingFailed;
  $('export-volume').disabled=loading||!lab?.result||renderingFailed;
}
function disposeObject(object) {
  if (!object) return;
  const textures = new Set(), materials = new Set(), geometries = new Set();
  object.traverse(child => {
    if (child.geometry) geometries.add(child.geometry);
    for (const material of [child.material].flat().filter(Boolean)) {
      materials.add(material); for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
  });
  geometries.forEach(x => x.dispose()); textures.forEach(x => x.dispose()); materials.forEach(x => x.dispose());
}

function initialize() {
 renderer=new THREE.WebGLRenderer({canvas:$('art'),alpha:true,antialias:true,preserveDrawingBuffer:true,powerPreference:'high-performance'});
 renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.setClearColor(0,0);
 scene=new THREE.Scene();camera=new THREE.PerspectiveCamera(38,1,.01,1000);
 orbit=new OrbitControls(camera,$('viewport'));orbit.enableDamping=true;orbit.dampingFactor=.075;orbit.autoRotateSpeed=.5;orbit.minDistance=.4;orbit.maxDistance=35;
 volumeScene=new THREE.Scene();volumeCamera=new THREE.PerspectiveCamera(38,1,.01,1000);
 volumeCamera.position.set(6,4,7);volumeCamera.lookAt(0,0,0);
 volumeRenderer=new THREE.WebGLRenderer({canvas:$('volume-art'),antialias:true,preserveDrawingBuffer:true,powerPreference:'high-performance'});
 volumeRenderer.setPixelRatio(Math.min(devicePixelRatio,1.5));volumeRenderer.setClearColor(0x07111b,1);
 volumeOrbit=new OrbitControls(volumeCamera,$('volume-pane'));volumeOrbit.enableDamping=true;volumeOrbit.dampingFactor=.075;volumeOrbit.minDistance=.4;volumeOrbit.maxDistance=35;
 $('rotate').checked=false;
 ctView=new CTView(renderer,camera);orthographicView=new OrthographicView($('ortho-art'));
 orthographicView.scanCapture=(viewCamera,output)=>renderScan(viewCamera,output);
 lab=new TomographyLab($('lab-art'),volumeScene,()=>{updateRenderInfo();updateExportButtons();updateReadingGuide();render();});
 lab.detailedFrame=(view,angle)=>orthographicView.detailedFrame(renderer,scene,view,angle);
 lab.detailPaper=()=>orthographicView.settings.paper;
 lab.onReadingChange=()=>updateReadingGuide();
 vectorEditor=new VectorEditor($('vector-art'),lab);
 $('scan-panel').after($('page-layout-controls'));
 lab.onVector=()=>{
   $('vector-work-panel').hidden=false;
   $('vector-status').textContent='Building the full-color vector from every scan sample…';
   requestAnimationFrame(()=>{
     try { vectorEditor.build(); }
     catch(error) { $('vector-status').textContent=`Vector conversion failed: ${error.message}`; console.error(error); }
   });
 };
 $('lab-pane').append($('loading'),$('drag-overlay'));
 postScene=new THREE.Scene();postCamera=new THREE.OrthographicCamera(-1,1,1,-1,0,1);
 postMaterial=new THREE.ShaderMaterial({depthTest:false,depthWrite:false,toneMapped:false,
 uniforms:{image:{value:ctView.output.texture},paper:{value:new THREE.Vector3(.95,.965,.94)},transparentOutput:{value:0}},
 vertexShader:'varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}',
 fragmentShader:'varying vec2 vUv;uniform sampler2D image;uniform vec3 paper;uniform float transparentOutput;void main(){vec4 c=texture2D(image,vUv);gl_FragColor=transparentOutput>.5?c:vec4(mix(paper,c.rgb,c.a),1.);}'
 });
 postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2,2),postMaterial));
 const observer=new ResizeObserver(resize);
 for(const id of ['viewport','ortho-viewport','lab-pane','volume-pane'])observer.observe($(id));
 resize();
 $('art').addEventListener('webglcontextlost',e=>{e.preventDefault();renderingFailed=true;updateExportButtons();toast('The graphics context was lost. Reload the page, then try a smaller model.',true);});
 requestAnimationFrame(animate);
}
function resize(){
 width=Math.max(1,$('viewport').clientWidth);height=Math.max(1,$('viewport').clientHeight);
 renderer.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix();
 const ortho=$('ortho-viewport'),reading=$('lab-pane'),volume=$('volume-pane');
 orthographicView.resize(Math.max(1,ortho.clientWidth),Math.max(1,ortho.clientHeight),renderer.getPixelRatio());
 lab?.resize(Math.max(1,reading.clientWidth),Math.max(1,reading.clientHeight),renderer.getPixelRatio());
 const vw=Math.max(1,volume.clientWidth),vh=Math.max(1,volume.clientHeight);
 volumeRenderer.setSize(vw,vh,false);volumeCamera.aspect=vw/vh;volumeCamera.updateProjectionMatrix();
 updateRenderInfo();
}
function renderScan(viewCamera,output=null){
 ctView.resize(output?output.width:width,output?output.height:height,output?1:renderer.getPixelRatio());
 ctView.render(renderer,scene,viewCamera);postMaterial.uniforms.transparentOutput.value=output?1:0;
 renderer.setRenderTarget(output);renderer.render(postScene,postCamera);
}
function render(){
 if(!root||renderingFailed)return;
 const signature=JSON.stringify(scanState);
 if(signature!==sheetSignature){orthographicView.cache.clear();orthographicView.dirty=true;sheetSignature=signature;}
 if(orthographicView.dirty&&(!scanState.sweep||performance.now()-lastOrthoFrame>180)){
   orthographicView.render(renderer,scene,currentName);lastOrthoFrame=performance.now();
 }
 renderScan(camera);
 volumeRenderer.render(volumeScene,volumeCamera);
}
function animate(time) {
  requestAnimationFrame(animate);
  if (document.hidden || time - lastFrame < 31) return;
  const delta = Math.min((time - lastFrame) / 1000, .1); lastFrame = time;
  orbit.update(delta);volumeOrbit.update(delta);
  if (scanState.slice && scanState.sweep && root && !activeImport) {
    scanState.position += delta * 13 * scanDirection;
    if (scanState.position >= 100 || scanState.position <= 0) { scanState.position = Math.max(0, Math.min(100, scanState.position)); scanDirection *= -1; }
    $('scan-position').value = scanState.position;
    $('scan-position-value').textContent = `${Math.round(scanState.position)}%`;
    ctView.configure(scanState); updateRenderInfo();
  }
  render(); frameCount++;
  if (time - fpsTime >= 1000) { $('fps').textContent = `${Math.round(frameCount * 1000 / (time - fpsTime))} FPS`; frameCount = 0; fpsTime = time; }
}
function fitCamera() {
  if (!root) return;
  const box = new THREE.Box3().setFromObject(root), size = box.getSize(new THREE.Vector3());
  const fov = camera.fov * Math.PI / 180;
  const direction = new THREE.Vector3(1.15, .65, 1.55).normalize();
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), direction).normalize();
  const up = new THREE.Vector3().crossVectors(direction, right).normalize();
  let fit = 0;
  for (const x of [-.5,.5]) for (const y of [-.5,.5]) for (const z of [-.5,.5]) {
    const corner = new THREE.Vector3(size.x*x,size.y*y,size.z*z);
    fit = Math.max(fit, Math.abs(corner.dot(right)) / (Math.tan(fov/2)*camera.aspect) + corner.dot(direction), Math.abs(corner.dot(up)) / Math.tan(fov/2) + corner.dot(direction));
  }
  fit *= 1.15;
  orbit.target.set(0, 0, 0); camera.position.copy(direction.multiplyScalar(fit));
  camera.near = .01; camera.far = Math.max(100, fit * 15); camera.updateProjectionMatrix(); orbit.update();
  volumeOrbit.target.set(0,0,0);volumeCamera.position.copy(camera.position);volumeCamera.near=.01;volumeCamera.far=camera.far;volumeCamera.updateProjectionMatrix();volumeOrbit.update();
}
function installModel(object, name, detail = '') {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  if (!Number.isFinite(size.length()) || size.length() === 0) { disposeObject(object); throw new Error('This model has no visible mesh geometry.'); }
  const group = new THREE.Group(); group.add(object); object.position.sub(center); group.scale.setScalar(4 / Math.max(size.x, size.y, size.z));
  ctView.clearModel();
  orthographicView.clearModel();
  if (root) { scene.remove(root); disposeObject(root); }
  root = group; scene.add(root); currentName = name; triangleCount = 0;
  ctView.setModel(root); ctView.configure(scanState);
  orthographicView.setModel(root);
  lab.setModel(root,name);vectorEditor.clear();lab.updateExportAvailability();
  sheetSignature='';
  const textures = new Set();
  root.traverse(child => {
    if (child.isMesh) { triangleCount += (child.geometry.index?.count ?? child.geometry.attributes.position.count) / 3;
      for (const m of [child.material].flat()) { if (m.map) textures.add(m.map); }
    }
  }); textureCount = textures.size;
  $('model-name').textContent = name; $('model-name').title = name;
  $('model-info').textContent = `${new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(triangleCount)} triangles · ${textureCount ? 'textured' : 'untextured'}`;
  $('stage-name').textContent = name.toUpperCase(); $('render-status').textContent = 'Ready to explore';
  $('model-indicator').style.background = 'var(--acid)'; fitCamera(); setLoading(false); updateRenderInfo(); updateReadingGuide();
  if (detail) toast(detail);
}
function beginImport(title) {
  activeImport?.abort();
  const controller = new AbortController();
  activeImport = controller; setLoading(true, title); progress(0, 'Reading files…');
  return controller;
}
function importError(error, controller) {
  if (controller.signal.aborted) return;
  setLoading(false); $('render-status').textContent = root ? 'Previous model retained' : 'Choose a model to begin';
  const message = /DRACOLoader|KTX2Loader|MeshoptDecoder/i.test(error.message || '') ? 'This GLTF uses compressed geometry or textures. Export an uncompressed GLB or an OBJ with textures and try again.' : error.message;
  toast(message || 'Unable to open this model. Please check the files and try again.', true);
}
function checkActive(controller) { if (controller.signal.aborted) throw new DOMException('Import cancelled', 'AbortError'); }
async function loadSample() {
  const controller = beginImport('Loading the Caltrans example');
  let mesh;
  try {
    const [metaResponse, meshResponse] = await Promise.all([fetch('./sample/model.json', { signal: controller.signal }), fetch('./sample/caltrans.bin', { signal: controller.signal })]);
    if (!metaResponse.ok || !meshResponse.ok) throw new Error('The example could not be loaded. You can still import your own files.');
    const meta = await metaResponse.json(), buffer = await meshResponse.arrayBuffer(); checkActive(controller); progress(70, 'Applying texture');
    const values = new THREE.InterleavedBuffer(new Float32Array(buffer), 8), geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.InterleavedBufferAttribute(values, 3, 0)); geometry.setAttribute('normal', new THREE.InterleavedBufferAttribute(values, 3, 3)); geometry.setAttribute('uv', new THREE.InterleavedBufferAttribute(values, 2, 6));
    const texture = await new THREE.TextureLoader().loadAsync('./sample/caltrans.png'); texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ map: texture, side: THREE.DoubleSide }));
    checkActive(controller); installModel(mesh, meta.name); mesh = null;
  } catch (error) { if (mesh) disposeObject(mesh); importError(error, controller); }
  finally { if (activeImport === controller) activeImport = null; }
}
function workerParse(file, controller) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./obj-worker.js', import.meta.url), { type: 'module' });
    const abort = () => { worker.terminate(); reject(new DOMException('Import cancelled', 'AbortError')); };
    controller.signal.addEventListener('abort', abort, { once: true });
    const done = () => { worker.terminate(); controller.signal.removeEventListener('abort', abort); };
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') progress(data.percent, `${data.message} · ${data.percent}%`);
      else if (data.type === 'complete') { done(); resolve(data.result); }
      else { done(); reject(new Error(data.message)); }
    };
    worker.onerror = () => { done(); reject(new Error('This mesh could not be processed. Try a smaller or triangulated OBJ.')); };
    worker.postMessage({ file });
  });
}
const normalizePath = path => decodeURIComponent(path).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
function makeResolver(files) {
  return name => {
    const normalized = normalizePath(name);
    const exact = files.find(f => normalizePath(f.webkitRelativePath || f.name) === normalized);
    if (exact) return exact;
    const suffix = files.filter(f => normalizePath(f.webkitRelativePath || f.name).endsWith('/' + normalized));
    if (suffix.length === 1) return suffix[0];
    const base = normalized.split('/').pop(), matches = files.filter(f => f.name.toLowerCase() === base);
    if (matches.length > 1) throw new Error(`More than one file is named ${base}. Select only the model's folder.`);
    return matches[0];
  };
}
function parseMTL(text) {
  const materials = {}; let current;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line[0] === '#') continue;
    const at = line.search(/\s/), kind = at < 0 ? line : line.slice(0, at), value = at < 0 ? '' : line.slice(at).trim();
    if (kind === 'newmtl') { current = { color: [1, 1, 1] }; materials[value] = current; }
    else if (current && kind === 'Kd') current.color = value.split(/\s+/).slice(0, 3).map(Number);
    else if (current && kind === 'map_Kd') {
      const tokens = value.match(/"[^"]*"|'[^']*'|\S+/g) || []; let i = 0;
      while (tokens[i]?.startsWith('-')) { const option = tokens[i++]; if (['-o', '-s', '-t'].includes(option)) { let n = 0; while (n < 3 && i < tokens.length && Number.isFinite(Number(tokens[i]))) { i++; n++; } } else i += option === '-mm' ? 2 : 1; }
      current.map = tokens.slice(i).join(' ').replace(/^['"]|['"]$/g, '');
    }
  } return materials;
}
async function loadOBJ(file, files, controller, urls) {
  const data = await workerParse(file, controller); checkActive(controller); progress(96, 'Applying materials and textures');
  const resolve = makeResolver(files), definitions = {};
  for (const mtl of files.filter(f => /\.mtl$/i.test(f.name))) Object.assign(definitions, parseMTL(await mtl.text()));
  const images = files.filter(f => /\.(png|jpe?g|webp)$/i.test(f.name)), missing = [];
  const materials = []; const textureCache = new Map();
  let geometry;
  try {
    for (const name of data.materials) {
      const definition = definitions[name] || {};
      const material = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide }); materials.push(material);
      if (definition.color?.every(Number.isFinite)) material.color.setRGB(...definition.color, THREE.SRGBColorSpace);
      const textureFile = definition.map ? resolve(definition.map) : images.length === 1 && data.hasUV ? images[0] : null;
      if (definition.map && !textureFile) missing.push(definition.map);
      if (textureFile) {
        let texture = textureCache.get(textureFile);
        if (!texture) { const url = URL.createObjectURL(textureFile); urls.push(url); texture = await new THREE.TextureLoader().loadAsync(url); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy()); textureCache.set(textureFile, texture); }
        material.map = texture;
      }
    }
    checkActive(controller);
    geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(data.position, 3)); geometry.setAttribute('normal', new THREE.BufferAttribute(data.normal, 3)); geometry.setAttribute('uv', new THREE.BufferAttribute(data.uv, 2));
    for (const g of data.groups) geometry.addGroup(g.start, g.count, g.materialIndex);
    return { object: new THREE.Mesh(geometry, materials), warning: missing.length ? `Loaded without ${[...new Set(missing)].join(', ')}. Select the OBJ, MTL and those textures together to include them.` : !data.hasUV && images.length ? 'This OBJ has no UV coordinates, so its image texture cannot be mapped.' : '' };
  } catch (error) { geometry?.dispose(); materials.forEach(m => m.dispose()); textureCache.forEach(t => t.dispose()); throw error; }
}
async function loadGLTF(file, files, controller, urls) {
  const resolve = makeResolver(files), manager = new THREE.LoadingManager(), blobURLs = new Map();
  const modelPath = normalizePath(file.webkitRelativePath || file.name), directory = modelPath.slice(0, modelPath.lastIndexOf('/') + 1);
  manager.setURLModifier(url => {
    if (/^(blob:|data:)/.test(url)) return url;
    const match = resolve(directory + url) || resolve(url);
    if (!match) throw new Error(`Missing model resource: ${url}. Select the GLTF, .bin and textures together.`);
    if (!blobURLs.has(match)) { const blob = URL.createObjectURL(match); blobURLs.set(match, blob); urls.push(blob); }
    return blobURLs.get(match);
  });
  const loader = new GLTFLoader(manager);
  const buffer = await file.arrayBuffer(); checkActive(controller); progress(55, 'Decoding model and textures');
  const gltf = await loader.parseAsync(buffer, '');
  if (controller.signal.aborted) { disposeObject(gltf.scene); checkActive(controller); }
  gltf.scene.traverse(child => { if (child.isMesh) for (const material of [child.material].flat()) material.side = THREE.DoubleSide; });
  return { object: gltf.scene, warning: '' };
}
async function importFiles(fileList) {
  const files = Array.from(fileList).filter(f => !f.name.startsWith('.'));
  if (!files.length) return;
  const models = files.filter(f => /\.(obj|glb|gltf)$/i.test(f.name));
  if (!models.length) { toast('Select an OBJ, GLB or GLTF model, together with its material and texture files.', true); return; }
  if (models.length > 1) { toast('Please select one model at a time, together with its material and texture files.', true); return; }
  const file = models[0];
  if (file.size > 650 * 1024 * 1024) { toast('This model exceeds the 650 MB import limit. Please simplify it or export a smaller GLB.', true); return; }
  const controller = beginImport(`Opening ${file.name}`), urls = []; let object;
  try {
    const result = /\.obj$/i.test(file.name) ? await loadOBJ(file, files, controller, urls) : await loadGLTF(file, files, controller, urls);
    object = result.object; checkActive(controller); installModel(object, file.name.replace(/\.(obj|glb|gltf)$/i, ''), result.warning || 'Model loaded. Drag to find your angle.'); object = null;
  } catch (error) { if (object) disposeObject(object); importError(error, controller); }
  finally { urls.forEach(url => URL.revokeObjectURL(url)); if (activeImport === controller) activeImport = null; }
}

function updateScanBackground(){
 const rgb=scanState.palette==='mono'?[.018,.027,.04]:[.95,.965,.94];
 postMaterial.uniforms.paper.value.set(...rgb);
 orthographicView.settings.paper='#'+rgb.map(c=>Math.round(c*255).toString(16).padStart(2,'0')).join('');
 $('scan-legend').classList.toggle('scan-on-dark',scanState.palette==='mono');
 $('viewport').classList.toggle('scan-dark',scanState.palette==='mono');
}
function updateRenderInfo(){
 const view=orthographicView.settings.view;
 $('scan-sweep').disabled=view==='all';$('sweep-note').hidden=view!=='all';
 $('render-label').textContent=scanState.slice?'CT / SLICE VIEW':'CT / X-RAY VIEW';
 $('grid-info').textContent=`Surface CT · ${view==='all'?'six orthographic views':ORTHO_VIEWS.find(v=>v.id===view).label}`+(lab?.result?` · ${lab.size}³ reconstruction`:' · reconstruction pending');
 $('ortho-art').setAttribute('aria-label','CT / X-ray: '+(view==='all'?'six orthographic views':view+' orthographic view'));
}
function updateReadingGuide(){
 const mode=$('lab-image').value;
 $('slice-reading-control').hidden=mode!=='slice';
 $('effect-reading-control').hidden=mode==='detail';
}
function selectOrthoView(view){
 if(view==='all'&&$('scan-sweep').checked){$('scan-sweep').checked=false;updateScan();}
 orthographicView.configure({view});
 document.querySelectorAll('[data-ortho-view]').forEach(button=>{const selected=button.dataset.orthoView===view;button.classList.toggle('active',selected);button.setAttribute('aria-pressed',String(selected));});
 updateRenderInfo();render();
}
function updateScan() {
  scanState.density = +$('scan-density').value; scanState.edges = +$('scan-edges').value;
  scanState.palette = $('scan-palette').value; scanState.slice = $('scan-slice').checked;
  scanState.axis = $('scan-axis').value; scanState.position = +$('scan-position').value;
  scanState.thickness = +$('scan-thickness').value; scanState.sweep = $('scan-sweep').checked;
  $('scan-density-value').textContent = scanState.density.toFixed(2);
  $('scan-edges-value').textContent = `${Math.round(scanState.edges * 100)}%`;
  $('scan-position-value').textContent = `${Math.round(scanState.position)}%`;
  $('scan-thickness-value').textContent = `${scanState.thickness}%`;
  $('slice-controls').disabled = !scanState.slice;
  $('scan-legend').classList.toggle('scan-mono', scanState.palette === 'mono');
  $('viewport').classList.toggle('scan-dark', scanState.palette === 'mono');
  ctView.configure(scanState); updateScanBackground(); updateRenderInfo(); render();
  lab?.invalidateDetail(); lab?.draw(); updateReadingGuide();
}
function resetScan() {
  for (const [key, value] of Object.entries(scanDefaults)) {
    const input = $(`scan-${key}`); if (typeof value === 'boolean') input.checked = value; else input.value = value;
  }
  scanDirection = 1; updateScan();
}
function download(blob, extension, exportMode = 'ct', name = currentName) {
  if (!blob) { toast('The export could not be created. Please try again.', true); return; }
  const link = document.createElement('a'), url = URL.createObjectURL(blob);
  link.href = url; link.download = `${(name || 'form').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 90)}-${exportMode}.${extension}`;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
async function entryFiles(entry, prefix = '') {
  if (entry.isFile) return new Promise((resolve, reject) => entry.file(file => { Object.defineProperty(file, 'webkitRelativePath', { value: prefix + file.name }); resolve([file]); }, reject));
  if (!entry.isDirectory) return [];
  const reader = entry.createReader(), result = []; let batch;
  do { batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject)); for (const child of batch) result.push(...await entryFiles(child, prefix + entry.name + '/')); } while (batch.length);
  return result;
}

function bindUI(){
 $('vector-close').onclick=()=>{ $('vector-work-panel').hidden=true; $('reading-vector-edit').focus(); };
 for(const id of ['lab-image','lab-detail-view','lab-slice','lab-angle','lab-effect','lab-palette','lab-resolution','lab-axis','lab-angles','lab-span','lab-filter'])$(id).addEventListener('input',updateReadingGuide);
 document.querySelectorAll('[data-ortho-view]').forEach(button=>button.onclick=()=>selectOrthoView(button.dataset.orthoView));
  $('upload').onclick = () => $('files').click(); $('choose-folder').onclick = () => $('folder').click(); $('load-sample').onclick = loadSample;
  for (const id of ['files', 'folder']) $(id).onchange = e => { importFiles(e.target.files); e.target.value = ''; };
  let dragDepth = 0;
  document.addEventListener('dragenter', e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); dragDepth++; $('lab-pane').classList.add('dragging'); } });
  document.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  document.addEventListener('dragleave', () => { dragDepth--; if (dragDepth <= 0) $('lab-pane').classList.remove('dragging'); });
  document.addEventListener('drop', async e => {
    e.preventDefault(); dragDepth = 0; $('lab-pane').classList.remove('dragging');
    const items = [...e.dataTransfer.items], fallback = [...e.dataTransfer.files];
    const entries = items.map(item => item.webkitGetAsEntry?.()).filter(Boolean);
    try { const files = entries.length ? (await Promise.all(entries.map(entry => entryFiles(entry)))).flat() : fallback; await importFiles(files); } catch (error) { toast('Unable to read that folder. Use Choose a folder instead.', true); }
  });
  $('cancel-load').onclick = () => { activeImport?.abort(); activeImport = null; setLoading(false); $('render-status').textContent = root ? 'Ready to explore' : 'Choose a model to begin'; toast('Import cancelled.'); };

 $('reset-camera').onclick=fitCamera;
 for(const key of Object.keys(scanDefaults))$('scan-'+key).addEventListener('input',()=>{if(key==='position')$('scan-sweep').checked=false;updateScan();});
 $('rotate').onchange=()=>{orbit.autoRotate=$('rotate').checked;};
 $('reset-scan').onclick=resetScan;
  $('help').onclick = () => $('help-dialog').showModal(); $('close-help').onclick = $('got-it').onclick = () => $('help-dialog').close();
  $('help-dialog').addEventListener('click', e => { if (e.target === $('help-dialog')) { const r = e.target.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.target.close(); } });

 $('export-png').onclick=()=>lab?.exportPNG();
 $('export-png-stage').onclick=()=> $('export-png').click();
 $('export-ortho').onclick=()=>{if(!root||renderingFailed)return;render();orthographicView.exportCanvas(currentName).toBlob(blob=>{download(blob,'png','ct-orthographic-'+orthographicView.settings.view);if(blob)toast('Orthographic CT exported as PNG.');},'image/png');};
 $('export-volume').onclick=()=>{if(!lab?.result||renderingFailed)return;volumeRenderer.render(volumeScene,volumeCamera);$('volume-art').toBlob(blob=>{download(blob,'png','ct-volume');if(blob)toast('3D volume exported as PNG.');},'image/png');};
 $('viewport').addEventListener('keydown',e=>{if(e.key.toLowerCase()==='r'){fitCamera();e.preventDefault();}else if(e.key===' '){$('rotate').checked=!$('rotate').checked;orbit.autoRotate=$('rotate').checked;e.preventDefault();}});
 updateScan();
 updateReadingGuide();
}
function registerTools(){
 const context=document.modelContext;if(!context?.registerTool)return;
 const lifecycle=new AbortController();window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
 const snapshot=()=>({model:currentName,triangles:triangleCount,textures:textureCount,loading:!!activeImport,view:orthographicView.settings.view,scan:{...scanState},autoRotate:orbit.autoRotate,reconstruction:lab?.result?{size:lab.size,angles:lab.result.options.angles}:null,vectorLayers:vectorEditor?.layers.length||0});
 const register=tool=>{try{Promise.resolve(context.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});}catch{}};
 register({name:'read_ct_workspace',description:'Read the CT scan model and settings.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true},execute:snapshot});
 const properties={view:{type:'string',enum:[...ORTHO_VIEWS.map(v=>v.id),'all']},palette:{type:'string',enum:['color','mono']},axis:{type:'string',enum:['x','y','z']},density:{type:'number',minimum:.2,maximum:3},edges:{type:'number',minimum:0,maximum:1},position:{type:'number',minimum:0,maximum:100},thickness:{type:'number',minimum:2,maximum:100},slice:{type:'boolean'},sweep:{type:'boolean'},autoRotate:{type:'boolean'}};
 register({name:'configure_ct_scan',description:'Configure CT palette, density, slicing, rotation and orthographic view.',inputSchema:{type:'object',properties,additionalProperties:false},annotations:{readOnlyHint:false},execute:input=>{
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Invalid scan settings.');
 for(const [key,value]of Object.entries(input)){const p=properties[key];if(!p||typeof value!==p.type||(p.enum&&!p.enum.includes(value))||(p.type==='number'&&(!Number.isFinite(value)||value<p.minimum||value>p.maximum)))throw new Error('Invalid setting: '+key);}
 for(const [key,value]of Object.entries(input)){if(Object.hasOwn(scanDefaults,key)){const el=$('scan-'+key);if(typeof value==='boolean')el.checked=value;else el.value=value;}}
 if(input.autoRotate!==undefined){$('rotate').checked=input.autoRotate;orbit.autoRotate=input.autoRotate;}
 updateScan();if(input.view!==undefined)selectOrthoView(input.view);return snapshot();
 }});
}
try { initialize(); bindUI(); registerTools(); loadSample(); }
catch (error) { setLoading(false); $('render-status').textContent = 'WebGL unavailable'; toast('This tool needs WebGL 2. Enable graphics acceleration or open it in a current Chrome, Edge, Firefox or Safari browser.', true); console.error(error); }

