import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import type { Engine } from './engine';
import { toCanvas } from './image';

/**
 * The level as one mesh with the painted texture. Painted under overcast light it is albedo, so it goes on a lit
 * material for the engine to light, with the normal and roughness maps when they've been made (core/pbr.ts);
 * painted with a sun the lighting is baked in, so it goes on an unlit one (KHR_materials_unlit).
 */
export async function exportGlb(engine: Engine): Promise<ArrayBuffer> {
  const { data, size } = engine.atlas.readBytes();
  const textures: THREE.Texture[] = [];
  const texture = (pixels: Uint8ClampedArray, s: number, colour = false) => {
    const t = new THREE.CanvasTexture(toCanvas(pixels, s, s)); // rows already in glTF order (first row = v 0)
    t.flipY = false;
    if (colour) t.colorSpace = THREE.SRGBColorSpace;
    textures.push(t);
    return t;
  };
  const map = texture(data, size, true);
  let material: THREE.Material;
  if (!engine.clay.lighting.overcast) material = new THREE.MeshBasicMaterial({ map });
  else if (engine.pbr) {
    // one image for roughness (G) and metalness (B, all 0): glTF's metallicRoughnessTexture as it is
    const orm = texture(engine.pbr.orm, engine.pbr.size);
    material = new THREE.MeshStandardMaterial({ map, normalMap: texture(engine.pbr.normal, engine.pbr.size),
      roughnessMap: orm, metalnessMap: orm, roughness: 1, metalness: 0 });
  } else material = new THREE.MeshStandardMaterial({ map, roughness: 0.92, metalness: 0 });
  const mesh = new THREE.Mesh(engine.level.geometry, material);
  mesh.name = engine.level.name;
  const glb = await new GLTFExporter().parseAsync(mesh, { binary: true, maxTextureSize: size });
  for (const t of textures) t.dispose();
  return glb as ArrayBuffer;
}
