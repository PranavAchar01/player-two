import * as THREE from "three";
import type { Sim } from "@/sim/sim";

const PLANE = 0, SPHERE = 2, CAPSULE = 3, CYLINDER = 5, BOX = 6;

/** Draws every MuJoCo geom with three.js, in MuJoCo's own z-up coordinates. */
export class Viewer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(38, 1, 0.05, 50);
  private meshes: THREE.Mesh[] = [];
  private sim?: Sim;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(2.35, 0, 1.5);
    this.camera.lookAt(0, 0, 1.28);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x1a1c22, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(2, -1.5, 3);
    this.scene.add(key);
  }

  setSim(sim: Sim) {
    for (const m of this.meshes) {
      this.scene.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.sim = sim;
    const { model } = sim;
    this.meshes = Array.from({ length: model.ngeom }, (_, g) => {
      const [sx, sy, sz] = [0, 1, 2].map((k) => model.geom_size[g * 3 + k]);
      const type = model.geom_type[g];
      let geo: THREE.BufferGeometry;
      if (type === PLANE) geo = new THREE.PlaneGeometry(8, 8);
      else if (type === SPHERE) geo = new THREE.SphereGeometry(sx, 32, 20);
      else if (type === CAPSULE) geo = new THREE.CapsuleGeometry(sx, sy * 2, 8, 20).rotateX(Math.PI / 2);
      else if (type === CYLINDER) geo = new THREE.CylinderGeometry(sx, sx, sy * 2, 24).rotateX(Math.PI / 2);
      else if (type === BOX) geo = new THREE.BoxGeometry(sx * 2, sy * 2, sz * 2);
      else geo = new THREE.SphereGeometry(0.01);
      const [r, gr, b, a] = [0, 1, 2, 3].map((k) => model.geom_rgba[g * 4 + k]);
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: new THREE.Color(r, gr, b), roughness: 0.55, metalness: 0.15, transparent: a < 1, opacity: a }));
      mesh.matrixAutoUpdate = false;
      this.scene.add(mesh);
      return mesh;
    });
  }

  /** `alarm` tints the robot red while a safety gate is holding it. */
  render(alarm = false) {
    const sim = this.sim;
    if (!sim) return;
    const { clientWidth: w, clientHeight: h } = this.canvas;
    if (this.canvas.width !== Math.floor(w * this.renderer.getPixelRatio())) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    const { geom_xpos: p, geom_xmat: m } = sim.data;
    this.meshes.forEach((mesh, g) => {
      const o = g * 9;
      mesh.matrix.set(m[o], m[o + 1], m[o + 2], p[g * 3], m[o + 3], m[o + 4], m[o + 5], p[g * 3 + 1], m[o + 6], m[o + 7], m[o + 8], p[g * 3 + 2], 0, 0, 0, 1);
      (mesh.material as THREE.MeshStandardMaterial).emissive.setRGB(alarm && g > 0 ? 0.5 : 0, 0, 0);
    });
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.renderer.dispose();
  }
}
