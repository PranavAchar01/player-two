import * as THREE from "three";
import type { Sim } from "@/sim/sim";

const PLANE = 0, SPHERE = 2, CAPSULE = 3, CYLINDER = 5, BOX = 6, MESH = 7;
const COLLISION_GROUP = 3;

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
    this.camera.position.set(2.5, 0, 1.12);
    this.camera.lookAt(0, 0, 0.98);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x1a1c22, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(2, -1.5, 3);
    this.scene.add(key);
  }

  setCamera(pos: [number, number, number], look: [number, number, number]) {
    this.camera.position.set(...pos);
    this.camera.lookAt(...look);
  }

  setSim(sim: Sim) {
    for (const m of this.meshes) {
      this.scene.remove(m);
      (m.material as THREE.Material).dispose();
    }
    this.sim = sim;
    const { model } = sim;
    const meshCache = new Map<number, THREE.BufferGeometry>();
    const meshGeometry = (m: number) => {
      let geo = meshCache.get(m);
      if (!geo) {
        const v0 = model.mesh_vertadr[m], f0 = model.mesh_faceadr[m];
        geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(model.mesh_vert.subarray(v0 * 3, (v0 + model.mesh_vertnum[m]) * 3)), 3));
        geo.setIndex(new THREE.BufferAttribute(new Uint32Array(model.mesh_face.subarray(f0 * 3, (f0 + model.mesh_facenum[m]) * 3)), 1));
        geo.computeVertexNormals();
        meshCache.set(m, geo);
      }
      return geo;
    };
    this.meshes = Array.from({ length: model.ngeom }, (_, g) => {
      const [sx, sy, sz] = [0, 1, 2].map((k) => model.geom_size[g * 3 + k]);
      const type = model.geom_type[g];
      let geo: THREE.BufferGeometry;
      if (model.geom_group[g] === COLLISION_GROUP) geo = new THREE.BufferGeometry();
      else if (type === MESH) geo = meshGeometry(model.geom_dataid[g]);
      else if (type === PLANE) geo = new THREE.PlaneGeometry(8, 8);
      else if (type === SPHERE) geo = new THREE.SphereGeometry(sx, 32, 20);
      else if (type === CAPSULE) geo = new THREE.CapsuleGeometry(sx, sy * 2, 8, 20).rotateX(Math.PI / 2);
      else if (type === CYLINDER) geo = new THREE.CylinderGeometry(sx, sx, sy * 2, 24).rotateX(Math.PI / 2);
      else if (type === BOX) geo = new THREE.BoxGeometry(sx * 2, sy * 2, sz * 2);
      else geo = new THREE.SphereGeometry(0.01);
      const mat = model.geom_matid[g];
      const [r, gr, b, a] = [0, 1, 2, 3].map((k) => (mat >= 0 ? model.mat_rgba[mat * 4 + k] : model.geom_rgba[g * 4 + k]));
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: new THREE.Color(r, gr, b), roughness: 0.42, metalness: 0.35, transparent: a < 1, opacity: a }));
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
