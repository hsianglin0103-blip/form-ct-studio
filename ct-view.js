import * as THREE from 'three';

// An artistic X-ray projection: accumulate all visible mesh surfaces, then map
// overlap to a scanner palette. This is not volumetric CT or material analysis.
export class CTView {
  constructor(renderer, camera) {
    const floating = renderer.extensions.has('EXT_color_buffer_float');
    this.storageScale = floating ? 1 : .125;
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: floating ? THREE.HalfFloatType : THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false,
    });
    // A transparent CT layer lets mesh and character layers show around it.
    this.output = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
    this.entries = [];
    this.materials = new Map();
    this.bounds = new THREE.Box3();
    this.shared = {
      scanWorldFromView: { value: camera.matrixWorld },
      scanOrthographic: { value: 0 },
      scanAxis: { value: new THREE.Vector3(0, 1, 0) },
      scanSlice: { value: 0 }, scanPosition: { value: 0 },
      scanHalfWidth: { value: .2 }, scanStorageScale: { value: this.storageScale },
    };
    this.postMaterial = new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false, toneMapped: false,
      uniforms: {
        layers: { value: this.target.texture }, texel: { value: new THREE.Vector2(1, 1) },
        exposure: { value: 1.1 }, edges: { value: .4 }, palette: { value: 0 },
        storageScale: { value: this.storageScale },
      },
      vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}',
      fragmentShader: `precision highp float;
        varying vec2 vUv; uniform sampler2D layers; uniform vec2 texel;
        uniform float exposure; uniform float edges; uniform float storageScale; uniform int palette;
        float density(vec2 uv){return 1.-exp(-texture2D(layers,uv).r/storageScale*exposure);}
        vec3 scanner(float d){
          vec3 paper=vec3(.95,.965,.94), amber=vec3(1.,.66,.19), orange=vec3(.97,.31,.025);
          vec3 green=vec3(.12,.46,.29), blue=vec3(.045,.22,.69), black=vec3(.008,.025,.055);
          if(d<.16)return mix(paper,amber,smoothstep(.008,.16,d));
          if(d<.38)return mix(amber,orange,(d-.16)/.22);
          if(d<.58)return mix(orange,green,(d-.38)/.20);
          if(d<.80)return mix(green,blue,(d-.58)/.22);
          return mix(blue,black,clamp((d-.80)/.20,0.,1.));
        }
        void main(){
          float d=density(vUv);
          float dx=abs(density(vUv+vec2(texel.x,0.))-density(vUv-vec2(texel.x,0.)));
          float dy=abs(density(vUv+vec2(0.,texel.y))-density(vUv-vec2(0.,texel.y)));
          float outline=clamp((dx+dy)*edges*1.8,0.,.65);
          vec3 color=scanner(d);
          if(palette==1)color=mix(vec3(.018,.027,.04),vec3(.90,.96,1.),pow(d,.65));
          color=mix(color,palette==1?vec3(.94,.98,1.):vec3(.01,.04,.075),outline);
          gl_FragColor=vec4(color,smoothstep(0.,.006,d));
        }`,
    });
    this.postScene = new THREE.Scene();
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.postMaterial);
    this.postScene.add(this.quad);
    this.postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  materialFor(source) {
    if (this.materials.has(source)) return this.materials.get(source);
    const material = new THREE.MeshBasicMaterial({
      map: source.map || null, alphaMap: source.alphaMap || null,
      alphaTest: source.alphaTest || 0, opacity: source.opacity ?? 1,
      color: source.color || 0xffffff, vertexColors: source.vertexColors,
      side: THREE.DoubleSide, depthTest: false, depthWrite: false,
      transparent: true, forceSinglePass: true, toneMapped: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      visible: source.visible,
    });
    material.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, this.shared);
      shader.vertexShader = `varying vec3 vScanViewPosition; varying vec3 vScanWorldPosition;
        uniform mat4 scanWorldFromView;\n` + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
        vScanViewPosition=mvPosition.xyz;
        vScanWorldPosition=(scanWorldFromView*mvPosition).xyz;`);
      shader.fragmentShader = `varying vec3 vScanViewPosition; varying vec3 vScanWorldPosition;
        uniform vec3 scanAxis; uniform float scanSlice; uniform float scanPosition;
        uniform float scanHalfWidth; uniform float scanStorageScale; uniform float scanOrthographic;\n` + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
        if(scanSlice>.5 && abs(dot(vScanWorldPosition,scanAxis)-scanPosition)>scanHalfWidth)discard;
        vec3 faceNormal=normalize(cross(dFdx(vScanViewPosition),dFdy(vScanViewPosition)));
        float facing=abs(dot(faceNormal,scanOrthographic>.5?vec3(0.,0.,1.):normalize(-vScanViewPosition)));
        float detail=1.-sqrt(clamp(dot(diffuseColor.rgb,vec3(.2126,.7152,.0722)),0.,1.));
        float optical=(.13+.18*detail)*(.75+.65*pow(1.-facing,1.5));
        optical*=diffuseColor.a*scanStorageScale;
        gl_FragColor=vec4(optical,0.,0.,1.);`);
      for (const chunk of ['tonemapping_fragment', 'colorspace_fragment', 'fog_fragment', 'premultiplied_alpha_fragment', 'dithering_fragment']) {
        shader.fragmentShader = shader.fragmentShader.replace(`#include <${chunk}>`, '');
      }
    };
    material.customProgramCacheKey = () => 'form-ascii-ct-v1';
    this.materials.set(source, material);
    return material;
  }

  setModel(root) {
    this.clearModel();
    if (!root) return;
    this.bounds.setFromObject(root);
    root.traverse(object => {
      if (!object.isMesh) return;
      const original = object.material;
      const scan = Array.isArray(original) ? original.map(m => this.materialFor(m)) : this.materialFor(original);
      this.entries.push({ object, original, scan });
    });
  }

  configure(settings) {
    const axis = settings.axis.toLowerCase();
    this.shared.scanAxis.value.set(+(axis === 'x'), +(axis === 'y'), +(axis === 'z'));
    const low = this.bounds.isEmpty() ? -2 : this.bounds.min[axis];
    const high = this.bounds.isEmpty() ? 2 : this.bounds.max[axis];
    this.shared.scanSlice.value = +settings.slice;
    this.shared.scanPosition.value = THREE.MathUtils.lerp(low, high, settings.position / 100);
    this.shared.scanHalfWidth.value = Math.max(.0001, (high - low) * settings.thickness / 200);
    this.postMaterial.uniforms.exposure.value = settings.density;
    this.postMaterial.uniforms.edges.value = settings.edges;
    this.postMaterial.uniforms.palette.value = settings.palette === 'mono' ? 1 : 0;
  }

  resize(width, height, pixelRatio) {
    const scale = Math.min(pixelRatio, 1.5, Math.sqrt(900000 / (width * height)));
    const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);
    if (this.output.width !== w || this.output.height !== h) this.output.setSize(w, h);
    this.postMaterial.uniforms.texel.value.set(1 / w, 1 / h);
  }

  render(renderer, scene, camera) {
    camera.updateMatrixWorld(true);
    this.shared.scanWorldFromView.value=camera.matrixWorld;
    this.shared.scanOrthographic.value=camera.isOrthographicCamera?1:0;
    const previousTarget = renderer.getRenderTarget();
    const previousClear = renderer.getClearColor(new THREE.Color()), previousAlpha = renderer.getClearAlpha();
    try {
      for (const entry of this.entries) entry.object.material = entry.scan;
      renderer.setRenderTarget(this.target); renderer.setClearColor(0, 0);
      renderer.render(scene, camera);
      for (const entry of this.entries) entry.object.material = entry.original;
      renderer.setRenderTarget(this.output); renderer.setClearColor(0, 0);
      renderer.render(this.postScene, this.postCamera);
    } finally {
      for (const entry of this.entries) entry.object.material = entry.original;
      renderer.setRenderTarget(previousTarget); renderer.setClearColor(previousClear, previousAlpha);
    }
  }

  clearModel() {
    // These materials borrow the original textures; dispose only the materials.
    for (const material of this.materials.values()) material.dispose();
    this.materials.clear(); this.entries = []; this.bounds.makeEmpty();
  }

  dispose() {
    this.clearModel(); this.target.dispose(); this.output.dispose(); this.postMaterial.dispose(); this.quad.geometry.dispose();
  }
}
