/**
 * The Glimpse compositor. One WebGL scene renders both the live preview and
 * every exported frame, driven entirely by FrameState from the sampler:
 *
 *   backdrop (gradient quad)
 *     └─ poseGroup (3D hero-shot rotation)
 *          └─ zoomGroup (scale + pan from camera state)
 *               ├─ shadow plane
 *               ├─ video plane (rounded-corner shader, video texture)
 *               └─ cursor + click-pulse sprites
 */

import * as THREE from 'three';
import type { Project, StyleSettings } from '../timeline/model';
import type { FrameState } from '../timeline/sampler';

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
  uniform float angle;
  void main() {
    vec2 dir = vec2(cos(angle), sin(angle));
    float t = clamp(dot(vUv - 0.5, dir) + 0.5, 0.0, 1.0);
    // Subtle dither to kill gradient banding.
    float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    gl_FragColor = vec4(mix(colorA, colorB, t) + (n - 0.5) / 255.0, 1.0);
  }
`;

const VIDEO_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const VIDEO_FRAG = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D map;
  uniform vec2 planeSize;   // world units
  uniform float radius;     // world units
  void main() {
    vec4 c = texture2D(map, vUv);
    // Rounded-rect SDF for corner masking with 1px-ish AA.
    vec2 p = (vUv - 0.5) * planeSize;
    vec2 b = planeSize * 0.5 - vec2(radius);
    vec2 d = abs(p) - b;
    float dist = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - radius;
    float aa = fwidth(dist);
    float alpha = 1.0 - smoothstep(-aa, aa, dist);
    gl_FragColor = vec4(c.rgb, alpha);
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

function makeCursorTexture(style: 'default' | 'circle'): THREE.Texture {
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = s;
  cv.height = s;
  const ctx = cv.getContext('2d')!;
  ctx.clearRect(0, 0, s, s);
  if (style === 'circle') {
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s * 0.28, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.lineWidth = s * 0.04;
    ctx.fill();
    ctx.stroke();
  } else {
    // Classic pointer arrow, drawn oversized then rendered small = crisp.
    const path = new Path2D('M 30 18 L 30 96 L 48 78 L 60 104 L 74 98 L 62 72 L 88 72 Z');
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur = 6;
    ctx.fillStyle = '#111';
    ctx.fill(path);
    ctx.restore();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 5;
    ctx.lineJoin = 'round';
    ctx.stroke(path);
    ctx.fillStyle = '#111';
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

export class GlimpseRenderer {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;

  private backdrop: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private poseGroup = new THREE.Group();
  private zoomGroup = new THREE.Group();
  private videoPlane: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private shadowPlane: THREE.Mesh;
  private cursorSprite: THREE.Sprite;
  private ringSprite: THREE.Sprite;
  private videoTexture: THREE.VideoTexture | null = null;

  private planeW = 1;
  private planeH = 1;
  private viewH = 1; // world-space height visible at plane depth
  private cursorStyle: 'default' | 'circle' = 'default';

  constructor(canvas: HTMLCanvasElement, private project: Project) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true, // exporter reads frames back
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 100);
    this.camera.position.z = 10;
    this.viewH = 2 * Math.tan(THREE.MathUtils.degToRad(15)) * 10;

    this.backdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        vertexShader: BACKDROP_VERT,
        fragmentShader: BACKDROP_FRAG,
        uniforms: {
          colorA: { value: new THREE.Color('#1b2a4a') },
          colorB: { value: new THREE.Color('#0b3b39') },
          angle: { value: 0 },
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

    this.cursorSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: makeCursorTexture('default'), depthTest: false }),
    );
    this.cursorSprite.center.set(0.23, 0.86); // hotspot at the arrow tip
    this.ringSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeRingTexture(),
        depthTest: false,
        transparent: true,
        opacity: 0,
      }),
    );

    this.zoomGroup.add(this.shadowPlane, this.videoPlane, this.cursorSprite, this.ringSprite);
    this.poseGroup.add(this.zoomGroup);
    this.scene.add(this.poseGroup);

    this.applyStyle(project.style);
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
    this.layout();
  }

  applyStyle(style: StyleSettings): void {
    const u = this.backdrop.material.uniforms;
    u.colorA.value.set(style.background.colorA);
    u.colorB.value.set(
      style.background.kind === 'solid' ? style.background.colorA : style.background.colorB,
    );
    u.angle.value = THREE.MathUtils.degToRad(style.background.angle);

    this.poseGroup.rotation.set(
      THREE.MathUtils.degToRad(style.pose.rotX),
      THREE.MathUtils.degToRad(style.pose.rotY),
      THREE.MathUtils.degToRad(style.pose.rotZ),
    );

    this.shadowPlane.visible = style.shadow;

    if (style.cursor.style !== 'none' && style.cursor.style !== this.cursorStyle) {
      this.cursorStyle = style.cursor.style;
      (this.cursorSprite.material.map as THREE.Texture | null)?.dispose();
      this.cursorSprite.material.map = makeCursorTexture(style.cursor.style);
      this.cursorSprite.center.set(
        style.cursor.style === 'circle' ? 0.5 : 0.23,
        style.cursor.style === 'circle' ? 0.5 : 0.86,
      );
      this.cursorSprite.material.needsUpdate = true;
    }
    this.layout();
  }

  /** Fit the recording into view with padding; size the shadow and radius. */
  private layout(): void {
    const { recording, style } = this.project;
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

  /** Render one frame from sampled state. Pure function of its input. */
  render(frame: FrameState): void {
    const { camera, cursor } = frame;
    const s = camera.scale;
    this.zoomGroup.scale.set(s, s, 1);
    this.zoomGroup.position.set(
      -(camera.focusX - 0.5) * this.planeW * s,
      (camera.focusY - 0.5) * this.planeH * s,
      0,
    );

    const style = this.project.style;
    this.cursorSprite.visible = cursor.visible;
    this.ringSprite.visible = cursor.visible && cursor.clickPulse > 0;
    if (cursor.visible) {
      const cx = (cursor.x - 0.5) * this.planeW;
      const cy = (0.5 - cursor.y) * this.planeH;
      const size = 0.032 * this.viewH * style.cursor.size;
      this.cursorSprite.position.set(cx, cy, 0.1);
      this.cursorSprite.scale.set(size, size, 1);
      if (cursor.clickPulse > 0) {
        const p = 1 - cursor.clickPulse; // 0 → just clicked
        this.ringSprite.position.set(cx, cy, 0.09);
        const ringSize = size * (0.8 + p * 2.2);
        this.ringSprite.scale.set(ringSize, ringSize, 1);
        (this.ringSprite.material as THREE.SpriteMaterial).opacity = cursor.clickPulse * 0.85;
      }
    }

    this.videoTexture && (this.videoTexture.needsUpdate = true);
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.videoTexture?.dispose();
    this.renderer.dispose();
  }
}
