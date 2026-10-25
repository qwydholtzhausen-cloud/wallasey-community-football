import * as THREE from "three";
import type { CabKind } from "../../lib/clubcabinet";

// The club cabinet's 3D shelf (app/ui/clubcabinet.tsx loads this on demand,
// so three.js only downloads when History opens). Gold trophies lit by studio
// softboxes, glass outlines for awards still to come, drag to spin, swipe to
// walk the shelf, tap to lift one forward, and the gold pour that presents a
// newly won award.

export interface ShelfItem {
  kind: CabKind;
  won: boolean;
  pour: boolean; // won, but this person hasn't seen it presented yet
  season: boolean;
  plateTop: string;
  plateName: string;
  ghostName: string; // on the plate until the gold pours in
  engrave: string | null;
}

export interface Cabinet {
  lightsOn: () => void;
  panTo: (i: number) => void;
  inspect: (i: number) => void;
  pour: (i: number) => void;
  poured: (i: number) => boolean;
  setRunning: (on: boolean) => void;
  destroy: () => void;
}

type Pt = [number, number];
const lathe = (pts: Pt[], m: THREE.Material, seg = 64) => new THREE.Mesh(new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), seg), m);

const CUP: Pt[] = [[0, 0], [.4, 0], [.4, .05], [.34, .08], [.16, .14], [.08, .2], [.065, .36], [.09, .42], [.14, .46], [.09, .5], [.07, .56], [.12, .62], [.28, .72], [.4, .86], [.46, 1.02], [.48, 1.16], [.5, 1.2], [.5, 1.23], [.47, 1.23], [.45, 1.14], [.42, .98], [.34, .82], [.1, .68], [0, .66]];
const OUTER = CUP.slice(0, 18);
// Cups' effective scale on the shelf (for the engraving band and the pour line),
// and how high each trophy's gold has to rise when it's presented.
const BOWL: Partial<Record<CabKind, { sx: number; sy: number; y0: number }>> = { potm: { sx: .8, sy: .8, y0: 0 }, pots: { sx: .855, sy: .945, y0: .06 } };
const POUR_TOP: Record<CabKind, number> = { potm: .99, pots: 1.62, gb: .62, gg: 1.1, pp: 1.3, gots: .9 };

const cup = (m: THREE.Material, sx: number, sy: number) => {
  const g = new THREE.Group();
  g.add(lathe(CUP.map(([x, y]) => [x * sx, y * sy]), m, 96));
  for (const s of [1, -1]) {
    const h = new THREE.Mesh(new THREE.TorusGeometry(.19 * sx, .026, 16, 48, Math.PI * 1.05), m);
    h.position.set(s * .43 * sx, .94 * sy, 0);
    h.rotation.z = s > 0 ? -Math.PI / 2 : Math.PI / 2;
    h.scale.y = 1.25 * sy;
    g.add(h);
  }
  return g;
};
// Player of the Season: the big one. A taller cup with a domed lid, a ball
// finial and a stepped foot, so it stands apart from the monthly cups.
const grand = (m: THREE.Material) => {
  const g = cup(m, .95, 1.05), top = 1.23 * 1.05;
  const lid = lathe([[.485, 0], [.47, .04], [.4, .1], [.26, .16], [.1, .2], [.065, .25], [.09, .28], [0, .29]], m, 96);
  lid.position.y = top; g.add(lid);
  const fin = new THREE.Mesh(new THREE.IcosahedronGeometry(.075, 1), m);
  fin.position.y = top + .36; g.add(fin);
  const step = lathe([[0, 0], [.5, 0], [.5, .04], [.44, .06], [0, .06]], m, 96);
  step.position.y = -.06; g.add(step);
  g.position.y = .06; g.scale.setScalar(.9);
  return g;
};
// Players' Player: a star on a column.
const star = (m: THREE.Material) => {
  const g = new THREE.Group();
  g.add(lathe([[0, 0], [.3, 0], [.3, .05], [.12, .1], [.08, .16], [.06, .6], [.1, .64], [0, .66]], m));
  const s = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? .13 : .3, a = Math.PI / 2 + (i * Math.PI) / 5;
    if (i) s.lineTo(Math.cos(a) * r, Math.sin(a) * r); else s.moveTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  const st = new THREE.Mesh(new THREE.ExtrudeGeometry(s, { depth: .07, bevelEnabled: true, bevelSize: .02, bevelThickness: .02, bevelSegments: 3 }), m);
  st.position.set(0, .96, -.035); g.add(st);
  return g;
};
// Inflate a flat outline into a soft, padded solid: a dense grid inside the
// outline, thickest in the middle and rounding to nothing at the edge. Gloves
// and boots are padded things, so this reads better than an extrusion.
const pillow = (shape: THREE.Shape, T: number, R: number, m: THREE.Material, warp: (v: THREE.Vector3) => void, n = 120) => {
  const poly = shape.getSpacedPoints(260);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of poly) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
  const inside = (x: number, y: number) => {
    let c = false;
    for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) { const A = poly[a], B = poly[b]; if (A.y > y !== B.y > y && x < ((B.x - A.x) * (y - A.y)) / (B.y - A.y) + A.x) c = !c; }
    return c;
  };
  const nearest = (x: number, y: number): [number, number, number] => {
    let best = Infinity, bx = 0, by = 0;
    for (let a = 0; a < poly.length - 1; a++) {
      const A = poly[a], B = poly[a + 1], dx = B.x - A.x, dy = B.y - A.y;
      const t = Math.max(0, Math.min(1, ((x - A.x) * dx + (y - A.y) * dy) / (dx * dx + dy * dy || 1)));
      const px = A.x + dx * t, py = A.y + dy * t, d = (x - px) ** 2 + (y - py) ** 2;
      if (d < best) { best = d; bx = px; by = py; }
    }
    return [bx, by, Math.sqrt(best)];
  };
  const nx = n, ny = Math.round((n * (y1 - y0)) / (x1 - x0));
  const grid: { inn: boolean; x: number; y: number; h: number }[] = [];
  for (let j = 0; j <= ny; j++)
    for (let i = 0; i <= nx; i++) {
      const x = x0 + ((x1 - x0) * i) / nx, y = y0 + ((y1 - y0) * j) / ny;
      const inn = inside(x, y), [bx, by, d] = nearest(x, y);
      grid.push({ inn, x: inn ? x : bx, y: inn ? y : by, h: inn ? T * Math.sqrt(1 - (1 - Math.min(d / R, 1)) ** 2) : 0 });
    }
  const at = (i: number, j: number) => grid[j * (nx + 1) + i];
  const pos: number[] = [], idx: number[] = [], vid = new Map<string, number>();
  const vert = (i: number, j: number, side: number) => {
    const g = at(i, j), k = `${i},${j},${g.h ? side : 0}`;
    if (!vid.has(k)) { vid.set(k, pos.length / 3); pos.push(g.x, g.y, g.h * side); }
    return vid.get(k)!;
  };
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const q: Pt[] = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
      if (!q.some(([a, b]) => at(a, b).inn)) continue;
      for (const side of [1, -1]) {
        const [a, b, c, d] = q.map(([u, v]) => vert(u, v, side));
        if (side > 0) idx.push(a, b, c, a, c, d); else idx.push(a, c, b, a, d, c);
      }
    }
  const P = new Float32Array(pos), v = new THREE.Vector3();
  for (let k = 0; k < P.length; k += 3) { v.set(P[k], P[k + 1], P[k + 2]); warp(v); P[k] = v.x; P[k + 1] = v.y; P[k + 2] = v.z; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(P, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, m);
};
// Golden Glove: an open keeper's glove, fingers spread, thumb out, palm
// cupped, on a wrist strap.
const glove = (m: THREE.Material) => {
  const g = new THREE.Group();
  g.add(lathe([[0, 0], [.3, 0], [.3, .05], [.12, .1], [.08, .22], [.11, .25], [0, .26]], m));
  const s = new THREE.Shape();
  s.moveTo(-.15, 0); s.lineTo(.15, 0); s.quadraticCurveTo(.205, .1, .205, .27);
  const finger = (a: number, b: number, tip: number, base: number) => {
    const mid = (a + b) / 2, r = (a - b) / 2;
    s.lineTo(a, tip - r); s.quadraticCurveTo(a, tip, mid, tip); s.quadraticCurveTo(b, tip, b, tip - r); s.lineTo(b + .002, base);
  };
  finger(.215, .118, .54, .37);
  finger(.114, .014, .65, .375);
  finger(.01, -.09, .69, .375);
  finger(-.094, -.19, .63, .34);
  s.quadraticCurveTo(-.25, .46, -.3, .45); s.quadraticCurveTo(-.36, .43, -.33, .36); s.lineTo(-.21, .17); s.quadraticCurveTo(-.17, .06, -.15, 0);
  const hand = pillow(s, .085, .06, m, (v) => {
    v.z -= .035 * Math.exp(-((v.x / .13) ** 2) - ((v.y - .24) / .13) ** 2); // cupped palm
    if (v.y > .36) { const t = (v.y - .36) * 1.4; v.y = .36 + Math.sin(t) / 1.4; v.z += ((1 - Math.cos(t)) / 1.4) * 1.2; } // fingers curl forward
  });
  hand.position.y = .36; g.add(hand);
  const strap = new THREE.Mesh(new THREE.CapsuleGeometry(.075, .3, 8, 24), m);
  strap.rotation.z = Math.PI / 2; strap.scale.set(1, 1, .75); strap.position.y = .34; g.add(strap);
  const tab = new THREE.Mesh(new THREE.BoxGeometry(.16, .06, .025), m);
  tab.position.set(.07, .345, .07); g.add(tab);
  return g;
};
// Golden Boot: a football boot on a column, toe up a little, on a sole plate
// with six studs.
const boot = (m: THREE.Material) => {
  const g = new THREE.Group();
  g.add(lathe([[0, 0], [.3, 0], [.3, .05], [.12, .1], [.07, .3], [.12, .33], [0, .34]], m));
  const s = new THREE.Shape();
  s.moveTo(-.33, .03); s.lineTo(.22, .03); s.quadraticCurveTo(.39, .03, .39, .09); s.quadraticCurveTo(.39, .14, .3, .155);
  s.quadraticCurveTo(.12, .18, 0, .27); s.lineTo(-.04, .31); s.quadraticCurveTo(-.15, .28, -.26, .33); s.quadraticCurveTo(-.33, .35, -.35, .27); s.quadraticCurveTo(-.37, .1, -.33, .03);
  const upper = pillow(s, .1, .14, m, (v) => { v.z *= 1 - Math.max(0, (v.x - .12) / .28) * .3; v.y += v.x * .1; });
  const shoe = new THREE.Group(); shoe.add(upper);
  const f = new THREE.Shape();
  f.moveTo(-.35, 0); f.quadraticCurveTo(-.35, .075, -.25, .08); f.lineTo(.1, .1); f.quadraticCurveTo(.41, .1, .41, 0);
  f.quadraticCurveTo(.41, -.1, .1, -.1); f.lineTo(-.25, -.08); f.quadraticCurveTo(-.35, -.075, -.35, 0);
  const sole = pillow(f, .02, .03, m, () => {}, 90); sole.rotation.x = -Math.PI / 2;
  const under = new THREE.Group(); under.add(sole); under.position.y = .03; under.rotation.z = Math.atan(.1);
  for (const [x, z] of [[-.25, .045], [-.25, -.045], [.03, .06], [.03, -.06], [.22, .055], [.22, -.055]]) {
    const st = new THREE.Mesh(new THREE.CylinderGeometry(.016, .022, .04, 12), m);
    st.position.set(x, -.035, z); under.add(st);
  }
  shoe.add(under);
  shoe.position.y = .36; shoe.rotation.z = .08; g.add(shoe);
  return g;
};
// Goal of the Season: a ball on a stand.
const ball = (m: THREE.Material) => {
  const g = new THREE.Group();
  g.add(lathe([[0, 0], [.3, 0], [.3, .05], [.12, .1], [.09, .3], [.16, .36], [0, .37]], m));
  const b = new THREE.Mesh(new THREE.IcosahedronGeometry(.27, 1), m);
  b.position.y = .62; g.add(b);
  return g;
};
const BUILD: Record<CabKind, (m: THREE.Material) => THREE.Group> = { potm: (m) => cup(m, .8, .8), pots: grand, pp: star, gg: glove, gb: boot, gots: ball };

const radiusAt = (y: number, sx: number, sy: number) => {
  for (let k = 1; k < OUTER.length; k++) {
    const [x0, y0] = OUTER[k - 1], [x1, y1] = OUTER[k];
    if (y <= y1 * sy) return (x0 + (x1 - x0) * Math.max(0, Math.min(1, (y - y0 * sy) / Math.max(1e-6, (y1 - y0) * sy)))) * sx;
  }
  return OUTER[OUTER.length - 1][0] * sx;
};

interface Slot {
  it: ShelfItem;
  x: number;
  lift: THREE.Group;
  spin: THREE.Group;
  ghost: THREE.Group | null;
  band: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshStandardMaterial> | null;
  ring: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>;
  clip: THREE.Plane;
  plMat: THREE.MeshStandardMaterial;
  plate: HTMLCanvasElement;
  glow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  spot: THREE.SpotLight;
  rot: number;
  vel: number;
  onAt: number;
  focus: number;
  focusTo: number;
  dim: number;
  pourAt: number;
  poured: boolean;
  flashAt: number;
  typeAt: number;
  typed: number;
}

export function mountCabinet(
  root: HTMLElement,
  canvas: HTMLCanvasElement,
  items: ShelfItem[],
  opts: { fonts: { label: string; display: string }; still: boolean; start: number; onChange: (center: number, inspecting: number) => void; onPoured: (i: number) => void }
): Cabinet {
  const H = canvas.clientHeight || 290;
  const W = () => root.clientWidth || 360;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(W(), H, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.localClippingEnabled = true;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x06080d);

  // Studio environment: a black room with a few softboxes, so the gold gets
  // crisp highlights and deep darks instead of a flat brown.
  const studio = new THREE.Scene();
  studio.add(new THREE.Mesh(new THREE.BoxGeometry(20, 20, 20), new THREE.MeshBasicMaterial({ color: 0x050505, side: THREE.BackSide })));
  const softbox = (w: number, h: number, x: number, y: number, z: number, k: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(k, k * .96, k * .88), side: THREE.DoubleSide }));
    m.position.set(x, y, z); m.lookAt(0, 0, 0); studio.add(m);
  };
  softbox(6, 1.4, 0, 7, 3, 9);
  softbox(2.2, 6, -7, 1, 2, 5);
  softbox(2.2, 6, 7, 1.5, -1, 3.2);
  softbox(4, 1, 0, -2, 8, 1.4);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(studio, .02);
  scene.environment = env.texture;
  studio.traverse((o) => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); o.material.dispose(); } });
  const cam = new THREE.PerspectiveCamera(27, W() / H, .1, 60);

  const GAP = 1.7, AWARD_GAP = .7;
  const firstSeason = items.findIndex((x) => x.season);
  const xs = items.map((_, i) => i * GAP + (firstSeason >= 0 && i >= firstSeason ? AWARD_GAP : 0));
  const total = xs[xs.length - 1] ?? 0;

  const wall = new THREE.Mesh(new THREE.PlaneGeometry(total + 30, 8), new THREE.MeshStandardMaterial({ color: 0x141927, roughness: .95, metalness: 0, envMapIntensity: .1 }));
  wall.position.set(total / 2, 2, -1.1); scene.add(wall);
  const shelf = new THREE.Mesh(new THREE.BoxGeometry(total + 30, .08, 1.7), new THREE.MeshPhysicalMaterial({ color: 0x07080d, roughness: .2, metalness: .3, clearcoat: 1, clearcoatRoughness: .05, envMapIntensity: .5 }));
  shelf.position.set(total / 2, -.041, -.2); scene.add(shelf);
  const edge = new THREE.Mesh(new THREE.BoxGeometry(total + 30, .012, .012), new THREE.MeshBasicMaterial({ color: 0xc9a54a }));
  edge.position.set(total / 2, 0, .65); scene.add(edge);
  scene.add(new THREE.AmbientLight(0xffffff, .04));

  const goldMat = (clip: THREE.Plane) => new THREE.MeshPhysicalMaterial({ color: 0xf6cf6e, metalness: 1, roughness: .1, clearcoat: .6, clearcoatRoughness: .06, envMapIntensity: 1.6, clippingPlanes: [clip], side: THREE.DoubleSide });
  const ghostMat = () =>
    new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { c: { value: new THREE.Color(0xf5d97a) }, a: { value: 0 } },
      vertexShader: "varying vec3 n;varying vec3 v;void main(){vec4 p=modelViewMatrix*vec4(position,1.);n=normalize(normalMatrix*normal);v=normalize(-p.xyz);gl_Position=projectionMatrix*p;}",
      fragmentShader: "uniform vec3 c;uniform float a;varying vec3 n;varying vec3 v;void main(){float r=pow(1.-abs(dot(normalize(n),v)),2.2);gl_FragColor=vec4(c*(r*.9+.03),1.)*a;}",
    });
  // One shared material per glass trophy, so fading it is one uniform.
  const ghostAlpha = (g: THREE.Group | null, k: number) => g?.traverse((o) => { if (o instanceof THREE.Mesh && o.material instanceof THREE.ShaderMaterial) o.material.uniforms.a.value = k; });

  // Engraved plates, drawn letter by letter when an award is presented.
  const drawPlate = (c: HTMLCanvasElement, it: ShelfItem, gold: boolean, n = Infinity) => {
    const x = c.getContext("2d");
    if (!x) return;
    x.clearRect(0, 0, 512, 176);
    if (gold) {
      const gr = x.createLinearGradient(0, 0, 512, 176);
      gr.addColorStop(0, "#a8822c"); gr.addColorStop(.45, "#f6dc94"); gr.addColorStop(1, "#9c7414");
      x.fillStyle = gr; x.fillRect(0, 0, 512, 176);
    } else {
      x.fillStyle = "#0c0f18"; x.fillRect(0, 0, 512, 176);
      x.strokeStyle = "rgba(245,217,122,.35)"; x.lineWidth = 3; x.strokeRect(8, 8, 496, 160);
    }
    const ink = gold ? "rgba(52,36,6,.92)" : "rgba(245,217,122,.7)";
    const spaced = (px: string) => { if ("letterSpacing" in x) (x as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = px; };
    x.textAlign = "center"; x.fillStyle = ink; spaced("6px");
    x.font = `600 30px ${opts.fonts.label}`;
    x.fillText(it.plateTop, 256, 62, 470);
    const name = gold ? it.plateName : it.ghostName;
    spaced("1px");
    let size = gold ? 46 : 34;
    x.font = `800 ${size}px ${opts.fonts.display}`;
    while (x.measureText(name).width > 460 && size > 22) x.font = `800 ${--size}px ${opts.fonts.display}`;
    const shown = name.slice(0, n), left = 256 - x.measureText(name).width / 2;
    x.textAlign = "left";
    if (gold) { x.fillStyle = "rgba(255,248,220,.6)"; x.fillText(shown, left, 130); }
    x.fillStyle = ink; x.fillText(shown, left, gold ? 128 : 126);
  };
  // The name engraved round a cup's bowl (twice, so it shows from any side).
  const bandTex = (text: string) => {
    const c = document.createElement("canvas"); c.width = 2048; c.height = 128;
    const x = c.getContext("2d")!;
    x.font = `600 46px ${opts.fonts.label}`; x.textAlign = "center"; x.textBaseline = "middle";
    if ("letterSpacing" in x) (x as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = "10px";
    for (const cx of [512, 1536]) { x.fillStyle = "rgba(255,240,200,.9)"; x.fillText(text, cx, 66, 980); x.fillStyle = "rgba(40,26,4,1)"; x.fillText(text, cx, 63, 980); }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    return t;
  };
  const radial = (stops: [number, string][]) => {
    const c = document.createElement("canvas"); c.width = c.height = 128;
    const x = c.getContext("2d")!, g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    stops.forEach(([o, s]) => g.addColorStop(o, s));
    x.fillStyle = g; x.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  };
  const shadowTex = radial([[0, "rgba(0,0,0,.8)"], [1, "rgba(0,0,0,0)"]]);
  const glowTex = radial([[0, "rgba(255,236,190,.5)"], [.5, "rgba(255,220,150,.1)"], [1, "rgba(255,220,150,0)"]]);
  const plinthMat = new THREE.MeshPhysicalMaterial({ color: 0x0a0c12, roughness: .22, metalness: .2, clearcoat: 1, envMapIntensity: .6 });
  const plinthGeo = new THREE.BoxGeometry(.8, .34, .8);

  const T: Slot[] = items.map((it, i) => {
    const x = xs[i];
    const base = new THREE.Group(); base.position.set(x, 0, 0); scene.add(base);
    const sh = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.4), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
    sh.rotation.x = -Math.PI / 2; sh.position.y = .003; base.add(sh);
    const pl = new THREE.Mesh(plinthGeo, plinthMat); pl.position.y = .17; base.add(pl);
    const golden = it.won && !it.pour;
    const plate = document.createElement("canvas"); plate.width = 512; plate.height = 176;
    drawPlate(plate, it, golden);
    const plTex = new THREE.CanvasTexture(plate); plTex.colorSpace = THREE.SRGBColorSpace; plTex.anisotropy = 4;
    const plMat = new THREE.MeshStandardMaterial({ map: plTex, metalness: golden ? .75 : 0, roughness: golden ? .3 : .8 });
    const pf = new THREE.Mesh(new THREE.PlaneGeometry(.66, .227), plMat); pf.position.set(0, .17, .401); base.add(pf);
    const lift = new THREE.Group(); lift.position.y = .34; base.add(lift);
    const spin = new THREE.Group(); lift.add(spin);
    const clip = new THREE.Plane(new THREE.Vector3(0, -1, 0), it.pour ? .34 : 99);
    if (it.won) spin.add(BUILD[it.kind](goldMat(clip)));
    const ghost = !it.won || it.pour ? BUILD[it.kind](ghostMat()) : null;
    if (ghost) spin.add(ghost);
    const bowl = BOWL[it.kind];
    let band: Slot["band"] = null;
    if (it.won && it.engrave && bowl) {
      band = new THREE.Mesh(new THREE.CylinderGeometry(.46 * bowl.sx + .003, .4 * bowl.sx + .003, .16 * bowl.sy, 96, 1, true), new THREE.MeshStandardMaterial({ map: bandTex(it.engrave), transparent: true, opacity: it.pour ? 0 : 1, metalness: .6, roughness: .45, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
      band.position.y = bowl.y0 + .94 * bowl.sy; spin.add(band);
    }
    // The molten line that rises through the glass when an award is poured.
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1, .012, 8, 96), new THREE.MeshBasicMaterial({ color: 0xfff1c4, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    ring.rotation.x = Math.PI / 2; lift.add(ring);
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 3), new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
    glow.position.set(x, 1.1, -1.09); scene.add(glow);
    const spot = new THREE.SpotLight(0xfff1d0, 0, 7, .36, .7, 1.6);
    spot.position.set(x + .15, 3.4, 1.6); spot.target = base; scene.add(spot);
    return { it, x, lift, spin, ghost, band, ring, clip, plMat, plate, glow, spot, rot: 0, vel: 0, onAt: opts.still ? -1e9 : Infinity, focus: 0, focusTo: 0, dim: 1, pourAt: Infinity, poured: !it.pour, flashAt: 0, typeAt: 0, typed: -1 };
  });

  let camX = xs[opts.start] ?? 0, camTo = camX, zoom = 0, zoomTo = 0;
  let current = -1, inspecting = -1;
  const center = () => T.reduce((b, t, i) => (Math.abs(t.x - camX) < Math.abs(T[b].x - camX) ? i : b), 0);
  const changed = () => opts.onChange(center(), inspecting);
  // Floodlights coming on: a flicker, then up to full.
  const flick = (dt: number) => (dt < 0 ? 0 : dt < 90 ? .6 : dt < 150 ? .1 : dt < 260 ? .85 : dt < 320 ? .45 : Math.min(1, .45 + (dt - 320) / 500));

  const ray = new THREE.Raycaster();
  const hit = (cx: number, cy: number) => {
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), cam);
    for (let i = 0; i < T.length; i++) if (ray.intersectObject(T[i].spin, true).length) return i;
    return -1;
  };
  let drag: { lx: number; t: number; i: number; moved: number; v: number } | null = null;
  const down = (e: PointerEvent) => { canvas.setPointerCapture(e.pointerId); drag = { lx: e.clientX, t: performance.now(), i: hit(e.clientX, e.clientY), moved: 0, v: 0 }; };
  const move = (e: PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.lx, now = performance.now(), dtt = Math.max(1, now - drag.t);
    drag.lx = e.clientX; drag.moved += Math.abs(dx); drag.t = now;
    const spun = drag.i >= 0 ? drag.i : inspecting;
    if (spun >= 0) { T[spun].rot += dx * .02; T[spun].vel = (dx * .02) / (dtt / 1000); }
    else { const k = 2.9 / W(); camX -= dx * k; camTo = camX; drag.v = (-dx * k) / (dtt / 1000); }
  };
  const up = () => {
    if (!drag) return;
    if (drag.moved < 6) api.inspect(drag.i >= 0 && drag.i !== inspecting ? drag.i : -1);
    else if (drag.i < 0 && inspecting < 0) { const proj = camX + drag.v * .25; camTo = T.reduce((b, t) => (Math.abs(t.x - proj) < Math.abs(b - proj) ? t.x : b), T[0].x); }
    drag = null;
  };
  // The page took the gesture (a vertical scroll): no tap, settle on a trophy.
  const cancel = () => { if (drag && inspecting < 0) camTo = T[center()].x; drag = null; };
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", cancel);
  const ro = new ResizeObserver(() => { renderer.setSize(W(), H, false); cam.aspect = W() / H; cam.updateProjectionMatrix(); });
  ro.observe(root);

  const pourPlate = (t: Slot, gold: boolean, n?: number) => { drawPlate(t.plate, t.it, gold, n); if (t.plMat.map) t.plMat.map.needsUpdate = true; };
  let raf = 0, running = false;
  const clock = new THREE.Clock();
  const frame = () => {
    raf = 0;
    if (!running) return;
    const dt = Math.min(.05, clock.getDelta()), now = performance.now();
    if (!drag || inspecting >= 0) camX += (camTo - camX) * Math.min(1, dt * 6);
    zoom += (zoomTo - zoom) * Math.min(1, dt * 4);
    cam.position.set(camX, 1.14 - zoom * .1, 4.9 - zoom * 1.3);
    cam.lookAt(camX, .74 + zoom * .1, 0);
    T.forEach((t, j) => {
      const on = flick(now - t.onAt);
      t.dim += ((inspecting >= 0 && j !== inspecting ? .18 : 1) - t.dim) * Math.min(1, dt * 5);
      const lit = on * t.dim, glass = !t.it.won;
      t.spot.intensity = (glass ? 12 : 46) * lit;
      t.glow.material.opacity = (glass ? .35 : .8) * lit;
      if (glass) ghostAlpha(t.ghost, lit * (opts.still ? .85 : .75 + .25 * Math.sin(now / 700 + t.x)));
      if (t.it.pour) {
        // The presentation: gold rises through the glass behind a molten line,
        // a flash of light, then the name engraves itself onto the plate.
        const p = (now - t.pourAt) / 2600, hMax = POUR_TOP[t.it.kind], bowl = BOWL[t.it.kind];
        if (p < 0) ghostAlpha(t.ghost, lit * .8);
        else if (p < 1) {
          const h = (1 - Math.pow(1 - p, 2.2)) * (hMax + .02);
          t.clip.constant = t.lift.position.y + h;
          const r = bowl ? radiusAt(Math.min(h - bowl.y0, 1.23 * bowl.sy), bowl.sx, bowl.sy) : .2;
          t.ring.position.y = h; t.ring.scale.set(r + .004, r + .004, 1);
          t.ring.material.opacity = Math.min(1, p * 8) * (1 - Math.max(0, (p - .9) * 10));
          ghostAlpha(t.ghost, lit * .8);
          t.spot.intensity *= .6 + .4 * p;
        } else if (!t.poured) {
          t.poured = true; t.clip.constant = 99; t.ring.material.opacity = 0; t.flashAt = now; t.typeAt = now + 250;
          t.plMat.metalness = .75; t.plMat.roughness = .3;
          opts.onPoured(j); changed();
        }
        if (t.poured && t.flashAt) {
          const f = (now - t.flashAt) / 900;
          ghostAlpha(t.ghost, Math.max(0, 1 - f * 1.5) * lit);
          t.spot.intensity *= 1 + Math.max(0, 1.4 * (1 - f));
          if (t.band) t.band.material.opacity = Math.min(1, Math.max(0, (now - t.typeAt - 300) / 900));
          const n = Math.floor((now - t.typeAt) / 70);
          if (n >= 0 && n !== t.typed && n <= t.it.plateName.length + 1) { t.typed = n; pourPlate(t, true, n); }
        }
      }
      if (!drag || drag.i !== j) { t.rot += t.vel * dt; t.vel *= Math.pow(.18, dt); }
      t.focus += (t.focusTo - t.focus) * Math.min(1, dt * 5);
      if (!opts.still && t.focus > .02 && Math.abs(t.vel) < .3) t.rot += dt * .5 * t.focus;
      t.spin.rotation.y = t.rot;
      t.lift.position.set(0, .34 + t.focus * .1, t.focus * .35);
    });
    const c = center();
    if (c !== current) { current = c; changed(); }
    renderer.render(scene, cam);
    raf = requestAnimationFrame(frame);
  };

  const api: Cabinet = {
    lightsOn: () => { const now = performance.now(); T.forEach((t, i) => { if (t.onAt === Infinity) t.onAt = now + i * 170; }); },
    panTo: (i) => { if (T[i]) camTo = T[i].x; },
    // Tap: the trophy comes forward, the camera moves in, the rest dim.
    inspect: (i) => {
      inspecting = i; zoomTo = i >= 0 ? 1 : 0;
      T.forEach((t, j) => (t.focusTo = j === i ? 1 : 0));
      if (i >= 0) camTo = T[i].x;
      changed();
    },
    pour: (i) => { if (T[i]?.it.pour && !T[i].poured) { T[i].pourAt = performance.now(); camTo = T[i].x; } },
    poured: (i) => !!T[i]?.poured,
    setRunning: (on) => { running = on; if (on && !raf) { clock.getDelta(); raf = requestAnimationFrame(frame); } },
    destroy: () => {
      running = false; cancelAnimationFrame(raf); ro.disconnect();
      canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up); canvas.removeEventListener("pointercancel", cancel);
      scene.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        o.geometry.dispose();
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        ms.forEach((m: THREE.Material & { map?: THREE.Texture | null }) => { m.map?.dispose(); m.dispose(); });
      });
      shadowTex.dispose(); glowTex.dispose(); env.dispose(); pmrem.dispose();
      renderer.dispose(); renderer.forceContextLoss();
    },
  };
  return api;
}
