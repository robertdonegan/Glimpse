/**
 * The Glimpse compositor. One WebGL scene renders both the live preview and
 * every exported frame, driven entirely by FrameState from the sampler:
 *
 *   backdrop (gradient / corner-gradient / solid / uploaded image quad)
 *     └─ poseGroup (3D hero-shot rotation, animated per frame)
 *          └─ zoomGroup (scale + pan from camera state)
 *               ├─ shadow plane
 *               ├─ video plane (rounded-corner + depth-of-field shader)
 *               ├─ overlay planes (imported graphics)
 *               └─ cursor + click-pulse planes (tilt with the screen)
 *
 * Depth of field lives inside the video-plane shader: each fragment knows its
 * view-space depth, and blur radius grows with distance from the focus plane.
 * The cursor and click pulses are meshes inside the pose group, so they
 * rotate flush with the screen instead of billboarding at the camera.
 */

import * as THREE from 'three';
import type { Overlay, Project, StyleSettings } from '../timeline/model';
import type { FrameState } from '../timeline/sampler';

/** Camera distance to the (untilted) video plane — the DoF focus distance. */
const FOCUS_DIST = 10;

const BACKDROP_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.999, 1.0);
  }
`;

const BACKDROP_FRAG = /* glsl */ `
  varying vec2 vUv;
  uniform vec3 colorA;
  uniform vec3 colorB;
  uniform vec3 colorC;
  uniform vec3 colorD;
  uniform float cornerMode;
  uniform float angle;
  uniform sampler2D image;
  uniform float useImage;
  uniform float imageAspect;
  uniform float viewAspect;
  void main() {
    if (useImage > 0.5) {
      // Cover-fit: fill the frame, crop the overflow axis.
      vec2 uv = vUv - 0.5;
      if (viewAspect > imageAspect) {
        uv.y *= imageAspect / viewAspect;
      } else {
        uv.x *= viewAspect / imageAspect;
      }
      gl_FragColor = vec4(texture2D(image, uv + 0.5).rgb, 1.0);
      return;
    }
    vec3 col;
    if (cornerMode > 0.5) {
      // Bilinear blend: A top-left, B top-right, C bottom-left, D bottom-right.
      col = mix(mix(colorC, colorD, vUv.x), mix(colorA, colorB, vUv.x), vUv.y);
    } else {
      vec2 dir = vec2(cos(angle), sin(angle));
      float t = clamp(dot(vUv - 0.5, dir) + 0.5, 0.0, 1.0);
      col = mix(colorA, colorB, t);
    }
    // Subtle dither to kill gradient banding.
    float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    gl_FragColor = vec4(col + (n - 0.5) / 255.0, 1.0);
  }
`;

const VIDEO_VERT = /* glsl */ `
  varying vec2 vUv;
  varying float vViewZ;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewZ = -mv.z; // positive distance from camera
    gl_Position = projectionMatrix * mv;
  }
`;

const VIDEO_FRAG = /* glsl */ `
  varying vec2 vUv;
  varying float vViewZ;
  uniform sampler2D map;
  uniform vec2 planeSize;   // world units
  uniform float radius;     // world units
  uniform float dofAmount;  // world blur radius per world unit of defocus; 0 = off
  uniform float focusDist;  // world units from camera

  // Rounded-rect SDF for corner masking with 1px-ish AA.
  float rectAlpha(vec2 uv) {
    vec2 p = (uv - 0.5) * planeSize;
    vec2 b = planeSize * 0.5 - vec2(radius);
    vec2 d = abs(p) - b;
    float dist = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - radius;
    float aa = fwidth(dist);
    return 1.0 - smoothstep(-aa, aa, dist);
  }

  void main() {
    float coc = dofAmount * abs(vViewZ - focusDist); // circle of confusion, world units
    coc = min(coc, 0.5);

    if (coc < 0.002) {
      vec4 c = texture2D(map, vUv);
      gl_FragColor = vec4(c.rgb, rectAlpha(vUv));
      return;
    }

    // Vogel spiral bokeh. Jitter stays within one tap spacing — enough to
    // break banding without dissolving into grain.
    const int TAPS = 32;
    float rot = (6.2831853 / float(TAPS)) *
      fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    vec2 uvPerWorld = 1.0 / planeSize;
    vec3 acc = texture2D(map, vUv).rgb;
    float accA = rectAlpha(vUv);
    for (int i = 0; i < TAPS; i++) {
      float a = 2.399963 * float(i) + rot;
      float r = sqrt((float(i) + 0.5) / float(TAPS));
      vec2 uv = vUv + vec2(cos(a), sin(a)) * r * coc * uvPerWorld;
      acc += texture2D(map, uv).rgb;
      accA += rectAlpha(uv);
    }
    gl_FragColor = vec4(acc / float(TAPS + 1), accA / float(TAPS + 1));
  }
`;

function makeShadowTexture(): THREE.Texture {
  const s = 256;
  const cv = document.createElement('canvas');
  cv.width = s;
  cv.height = s;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, s * 0.1, s / 2, s / 2, s * 0.5);
  g.addColorStop(0, 'rgba(0,0,0,0.55)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(cv);
  tex.needsUpdate = true;
  return tex;
}

type CursorTexKind = 'default' | 'circle' | 'hand';

/** Texture anchor (0..1, y from bottom) per cursor art — the hotspot. */
const CURSOR_HOTSPOT: Record<CursorTexKind, [number, number]> = {
  default: [0.23, 0.86],
  circle: [0.5, 0.5],
  hand: [0.44, 0.9],
};

/** Outline colour that reads against the fill. */
function contrastFor(hex: string): string {
  const n = parseInt(hex.replace('#', '').slice(0, 6), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  return luma > 140 ? 'rgba(0,0,0,0.75)' : '#ffffff';
}

function makeCursorTexture(kind: CursorTexKind, color: string): THREE.Texture {
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = s;
  cv.height = s;
  const ctx = cv.getContext('2d')!;
  ctx.clearRect(0, 0, s, s);
  const outline = contrastFor(color);
  if (kind === 'circle') {
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s * 0.28, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.92;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = outline;
    ctx.lineWidth = s * 0.04;
    ctx.stroke();
  } else if (kind === 'hand') {
    // Pointing hand, OS style.
    const path = new Path2D(
      'M 56 14 c -5 0 -9 4 -9 9 v 40 l -9 -9 c -4 -4 -10 -4 -14 0 ' +
        'c -3 4 -3 9 0 13 l 24 26 c 4 4 9 6 14 6 h 20 c 9 0 16 -6 17 -15 ' +
        'l 5 -28 c 1 -7 -4 -13 -11 -13 h -28 v -20 c 0 -5 -4 -9 -9 -9 z',
    );
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 6;
    ctx.fillStyle = color;
    ctx.fill(path);
    ctx.restore();
    ctx.strokeStyle = outline;
    ctx.lineWidth = 5;
    ctx.lineJoin = 'round';
    ctx.stroke(path);
    ctx.fillStyle = color;
    ctx.fill(path);
  } else {
    // Classic pointer arrow, drawn oversized then rendered small = crisp.
    const path = new Path2D('M 30 18 L 30 96 L 48 78 L 60 104 L 74 98 L 62 72 L 88 72 Z');
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur = 6;
    ctx.fillStyle = color;
    ctx.fill(path);
    ctx.restore();
    ctx.strokeStyle = outline;
    ctx.lineWidth = 5;
    ctx.lineJoin = 'round';
    ctx.stroke(path);
    ctx.fillStyle = color;
    ctx.fill(path);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.needsUpdate = true;
  return tex;
}

function makeRingTexture(): THREE.Texture {
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = s;
  cv.height = s;
  const ctx = cv.getContext('2d')!;
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s * 0.42, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = s * 0.05;
  ctx.stroke();
  const tex = new THREE.CanvasTexture(cv);
  tex.needsUpdate = true;
  return tex;
}

/** Rasterise an image/SVG data-URL into a texture (SVGs get a crisp 1024px). */
function loadOverlayTexture(
  src: string,
  onReady: (tex: THREE.Texture, aspect: number) => void,
): void {
  const img = new Image();
  img.onload = () => {
    const w = img.naturalWidth || 512;
    const h = img.naturalHeight || 512;
    const scale = Math.min(1024 / Math.max(w, h), 4);
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w * scale));
    cv.height = Math.max(1, Math.round(h * scale));
    const ctx = cv.getContext('2d')!;
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    onReady(tex, w / h);
  };
  img.src = src;
}

interface OverlayNode {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  src: string;
  aspect: number;
}

type FlatMaterial = THREE.MeshBasicMaterial;

export class GlimpseRenderer {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;

  private backdrop: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private poseGroup = new THREE.Group();
  private zoomGroup = new THREE.Group();
  private videoPlane: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private shadowPlane: THREE.Mesh;
  private cursorMesh: THREE.Mesh<THREE.PlaneGeometry, FlatMaterial>;
  private ringMesh: THREE.Mesh<THREE.PlaneGeometry, FlatMaterial>;
  private videoTexture: THREE.VideoTexture | null = null;

  private backdropImage: THREE.Texture | null = null;
  private backdropImageSrc: string | null = null;

  private cursorTextures = new Map<string, THREE.Texture>();
  private activeCursorKey = '';
  private activeHotspot: [number, number] = CURSOR_HOTSPOT.default;
  private cursorColor = '#111111';

  private overlays = new Map<string, OverlayNode>();
  private overlayList: Overlay[] = [];

  /** Live style — refreshed on every applyStyle so edits actually land. */
  private style: StyleSettings;

  private planeW = 1;
  private planeH = 1;
  private viewH = 1; // world-space height visible at plane depth

  constructor(canvas: HTMLCanvasElement, private project: Project) {
    this.style = project.style;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true, // exporter reads frames back
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 100);
    this.camera.position.z = FOCUS_DIST;
    this.viewH = 2 * Math.tan(THREE.MathUtils.degToRad(15)) * FOCUS_DIST;

    this.backdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        vertexShader: BACKDROP_VERT,
        fragmentShader: BACKDROP_FRAG,
        uniforms: {
          colorA: { value: new THREE.Color('#1b2a4a') },
          colorB: { value: new THREE.Color('#0b3b39') },
          colorC: { value: new THREE.Color('#0b3b39') },
          colorD: { value: new THREE.Color('#1b2a4a') },
          cornerMode: { value: 0 },
          angle: { value: 0 },
          image: { value: null },
          useImage: { value: 0 },
          imageAspect: { value: 1 },
          viewAspect: { value: 16 / 9 },
        },
        depthWrite: false,
      }),
    );
    this.backdrop.frustumCulled = false;
    this.scene.add(this.backdrop);

    this.videoPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        vertexShader: VIDEO_VERT,
        fragmentShader: VIDEO_FRAG,
        uniforms: {
          map: { value: null },
          planeSize: { value: new THREE.Vector2(1, 1) },
          radius: { value: 0.05 },
          dofAmount: { value: 0 },
          focusDist: { value: FOCUS_DIST },
        },
        transparent: true,
      }),
    );

    this.shadowPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: makeShadowTexture(),
        transparent: true,
        depthWrite: false,
      }),
    );
    this.shadowPlane.position.z = -0.05;

    // Cursor + click pulse are meshes inside the pose group so they tilt
    // flush with the screen instead of billboarding at the camera.
    this.cursorMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false }),
    );
    this.cursorMesh.renderOrder = 10;
    this.ringMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: makeRingTexture(),
        transparent: true,
        depthTest: false,
        depthWrite: false,
        opacity: 0,
      }),
    );
    this.ringMesh.renderOrder = 9;

    this.zoomGroup.add(this.shadowPlane, this.videoPlane, this.cursorMesh, this.ringMesh);
    this.poseGroup.add(this.zoomGroup);
    this.scene.add(this.poseGroup);

    this.setCursorTexture('default');
    this.applyStyle(project.style);
    this.applyOverlays(project.overlays ?? []);
    this.resize(project.output.width, project.output.height);
  }

  attachVideo(video: HTMLVideoElement): void {
    this.videoTexture?.dispose();
    this.videoTexture = new THREE.VideoTexture(video);
    this.videoTexture.colorSpace = THREE.SRGBColorSpace;
    this.videoTexture.minFilter = THREE.LinearFilter;
    this.videoPlane.material.uniforms.map.value = this.videoTexture;
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.backdrop.material.uniforms.viewAspect.value = width / height;
    this.layout();
  }

  applyStyle(style: StyleSettings): void {
    this.style = style;
    const u = this.backdrop.material.uniforms;
    u.colorA.value.set(style.background.colorA);
    u.colorB.value.set(
      style.background.kind === 'solid' ? style.background.colorA : style.background.colorB,
    );
    u.colorC.value.set(style.background.colorC ?? style.background.colorB);
    u.colorD.value.set(style.background.colorD ?? style.background.colorA);
    u.cornerMode.value = style.background.kind === 'corners' ? 1 : 0;
    u.angle.value = THREE.MathUtils.degToRad(style.background.angle);
    this.applyBackdropImage(style);

    this.shadowPlane.visible = style.shadow;
    this.cursorColor = style.cursor.color || '#111111';

    // DoF: blur radius grows with world-space distance from the focus plane.
    this.videoPlane.material.uniforms.dofAmount.value = style.dof.enabled
      ? style.dof.strength * 0.28
      : 0;

    this.layout();
  }

  /** Sync overlay graphics with the project's overlay list. */
  applyOverlays(overlays: Overlay[]): void {
    this.overlayList = overlays;
    const alive = new Set(overlays.map((o) => o.id));
    for (const [id, node] of this.overlays) {
      if (!alive.has(id)) {
        this.zoomGroup.remove(node.mesh);
        (node.mesh.material.map as THREE.Texture | null)?.dispose();
        node.mesh.material.dispose();
        this.overlays.delete(id);
      }
    }
    for (const o of overlays) {
      const existing = this.overlays.get(o.id);
      if (existing && existing.src === o.imageData) continue;
      if (existing) {
        this.zoomGroup.remove(existing.mesh);
        (existing.mesh.material.map as THREE.Texture | null)?.dispose();
        existing.mesh.material.dispose();
        this.overlays.delete(o.id);
      }
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          transparent: true,
          depthTest: false,
          depthWrite: false,
          opacity: 0,
        }),
      );
      mesh.renderOrder = 5;
      mesh.visible = false;
      this.zoomGroup.add(mesh);
      const node: OverlayNode = { mesh, src: o.imageData, aspect: 1 };
      this.overlays.set(o.id, node);
      loadOverlayTexture(o.imageData, (tex, aspect) => {
        if (this.overlays.get(o.id) !== node) {
          tex.dispose();
          return;
        }
        node.aspect = aspect;
        mesh.material.map = tex;
        mesh.material.needsUpdate = true;
      });
    }
  }

  private applyBackdropImage(style: StyleSettings): void {
    const u = this.backdrop.material.uniforms;
    const src = style.background.kind === 'image' ? style.background.imageData ?? null : null;
    if (!src) {
      u.useImage.value = 0;
      return;
    }
    if (src === this.backdropImageSrc) {
      u.useImage.value = 1;
      return;
    }
    this.backdropImageSrc = src;
    const img = new Image();
    img.onload = () => {
      if (this.backdropImageSrc !== src) return; // superseded meanwhile
      this.backdropImage?.dispose();
      const tex = new THREE.Texture(img);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      this.backdropImage = tex;
      u.image.value = tex;
      u.imageAspect.value = img.width / img.height;
      u.useImage.value = 1;
    };
    img.src = src;
  }

  /** Fit the recording into view with padding; size the shadow and radius. */
  private layout(): void {
    const { recording } = this.project;
    const style = this.style;
    const viewW = this.viewH * this.camera.aspect;
    const pad = 1 - style.padding * 2;
    const recAspect = recording.width / recording.height;

    let w = viewW * pad;
    let h = w / recAspect;
    if (h > this.viewH * pad) {
      h = this.viewH * pad;
      w = h * recAspect;
    }
    this.planeW = w;
    this.planeH = h;
    this.videoPlane.scale.set(w, h, 1);
    this.shadowPlane.scale.set(w * 1.18, h * 1.18, 1);
    this.shadowPlane.position.y = -h * 0.04;

    const uniforms = this.videoPlane.material.uniforms;
    uniforms.planeSize.value.set(w, h);
    // cornerRadius is authored in recording pixels; convert to world units.
    uniforms.radius.value = (style.cornerRadius / recording.height) * h;
  }

  private setCursorTexture(kind: CursorTexKind): void {
    const key = `${kind}:${this.cursorColor}`;
    if (key === this.activeCursorKey) return;
    this.activeCursorKey = key;
    this.activeHotspot = CURSOR_HOTSPOT[kind];
    let tex = this.cursorTextures.get(key);
    if (!tex) {
      tex = makeCursorTexture(kind, this.cursorColor);
      this.cursorTextures.set(key, tex);
    }
    this.cursorMesh.material.map = tex;
    this.cursorMesh.material.needsUpdate = true;
  }

  /** Render one frame from sampled state. Pure function of its input. */
  render(frame: FrameState): void {
    const { camera, cursor, pose } = frame;

    this.poseGroup.rotation.set(
      THREE.MathUtils.degToRad(pose.rotX),
      THREE.MathUtils.degToRad(pose.rotY),
      THREE.MathUtils.degToRad(pose.rotZ),
    );

    const s = camera.scale;
    this.zoomGroup.scale.set(s, s, 1);
    this.zoomGroup.position.set(
      -(camera.focusX - 0.5) * this.planeW * s,
      (camera.focusY - 0.5) * this.planeH * s,
      0,
    );

    // Overlays: visible inside their time window.
    for (const o of this.overlayList) {
      const node = this.overlays.get(o.id);
      if (!node) continue;
      const visible = frame.t >= o.start && frame.t <= o.end && !!node.mesh.material.map;
      node.mesh.visible = visible;
      if (visible) {
        const w = o.scale * this.planeW;
        const h = w / node.aspect;
        node.mesh.scale.set(w, h, 1);
        node.mesh.position.set(
          (o.x - 0.5) * this.planeW,
          (0.5 - o.y) * this.planeH,
          0.06,
        );
        node.mesh.material.opacity = o.opacity;
      }
    }

    const style = this.style;
    this.cursorMesh.visible = cursor.visible && style.cursor.style !== 'none';
    this.ringMesh.visible =
      cursor.visible && cursor.clickPulse > 0 && style.cursor.style !== 'none';
    if (this.cursorMesh.visible) {
      if (style.cursor.style === 'circle') this.setCursorTexture('circle');
      else this.setCursorTexture(cursor.hand && style.cursor.handOnHover ? 'hand' : 'default');

      const cx = (cursor.x - 0.5) * this.planeW;
      const cy = (0.5 - cursor.y) * this.planeH;
      const size = 0.032 * this.viewH * style.cursor.size;
      // Offset so the texture's hotspot (arrow tip / fingertip) sits on the
      // recorded position.
      const [hx, hy] = this.activeHotspot;
      this.cursorMesh.position.set(
        cx + (0.5 - hx) * size,
        cy + (0.5 - hy) * size,
        0.1,
      );
      this.cursorMesh.scale.set(size, size, 1);
      if (cursor.clickPulse > 0) {
        const p = 1 - cursor.clickPulse; // 0 → just clicked
        this.ringMesh.position.set(cx, cy, 0.09);
        const ringSize = size * (0.8 + p * 2.2);
        this.ringMesh.scale.set(ringSize, ringSize, 1);
        this.ringMesh.material.opacity = cursor.clickPulse * 0.85;
      }
    }

    this.videoTexture && (this.videoTexture.needsUpdate = true);
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.videoTexture?.dispose();
    this.backdropImage?.dispose();
    this.cursorTextures.forEach((t) => t.dispose());
    for (const node of this.overlays.values()) {
      (node.mesh.material.map as THREE.Texture | null)?.dispose();
      node.mesh.material.dispose();
    }
    this.renderer.dispose();
  }
}
