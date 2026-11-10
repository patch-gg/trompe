/**
 * Image-edit models the pipeline can call, with what each accepts. Prices are fal's listed per-image prices
 * (token-priced models estimated). Defaults come from the spike (spike/README.md): FLUX 3 Klein keeps the
 * camera and geometry for first views; Fibo 2 with a mask gives the cleanest fills.
 */
export interface EditInput {
  imageUrl: string;
  maskUrl?: string;
  prompt: PromptContext;
  seed: number;
  size: number;
}

export interface EditModel {
  key: string;
  label: string;
  endpoint: string;
  /** null: no mask input; 'white'/'black': which mask colour means "paint here". */
  mask: null | 'white' | 'black';
  price: number;
  input(i: EditInput): Record<string, unknown>;
}

/** What one view asks for. Built per view from the labelled geometry (core/semantics.ts). */
export interface PromptContext {
  /** Materials only, never objects: whatever a prompt names, the models paint somewhere. */
  look: string;
  /** Roof material for roof passes. */
  roofLook: string;
  /** Parts of the level in the area to paint with rough positions; '' when the level has no part names. */
  parts: string;
  /** first: nothing painted in view yet; fill: continue the texture around the gaps; roof: paint roofs only. */
  mode: 'first' | 'fill' | 'roof';
  /** The area to paint is mostly ground. */
  floor: boolean;
  /** Painting under overcast light (no cast shadows wanted) rather than keeping the render's sun and shadows. */
  overcast?: boolean;
}

/** Things the models like to add to a street scene; listed as forbidden unless the level models them. */
const ADDITIONS = ['awnings', 'market stalls', 'shop fronts', 'signs', 'lamps', 'plants', 'crates', 'barrels',
  'benches', 'furniture', 'people', 'cars'];

function forbidden(parts: string) {
  const have = new Set(parts.toLowerCase().split(/[^a-z]+/).map((w) => w.replace(/s$/, '')));
  return ADDITIONS.filter((a) => !a.split(' ').some((w) => have.has(w.replace(/s$/, '')))).join(', ');
}

const shapes = (c: PromptContext) => (c.parts ? `: ${c.parts}` : '');
/** How the light should look: the render's own sun and shadows, or soft overcast light with no cast shadows. */
const light = (c: PromptContext) => (c.overcast
  ? 'soft, even overcast daylight with no cast shadows and no sunlit patches'
  : 'the same light direction and shadows');
const surfaces = (c: PromptContext) =>
  'Walls may show flat details such as windows, doors, shutters and stonework, but nothing sticks out of them and ' +
  `nothing new is added: no ${forbidden(c.parts)}.` + (c.floor ? ' The ground stays clear: bare paving.' : '');

export const prompts = {
  /** Instruction-style (Fibo, Ideogram, Nano Banana, FLUX 3). */
  instruction(c: PromptContext): string {
    if (c.mode === 'roof') {
      return `Paint the masked roof surfaces as ${c.roofLook}. Follow each roof's exact outline and slope, with ` +
        `${light(c)}. Paint nothing outside the mask, and add nothing on the roofs: no ` +
        'chimneys, antennas, windows, solar panels or plants.';
    }
    if (c.mode === 'first') {
      return `Turn this untextured gray 3D render into a photorealistic photo of ${c.look}. Every gray shape keeps ` +
        `its exact outline and becomes the real surface it is${shapes(c)}. Keep exactly the same camera, ` +
        `perspective and edges, with ${light(c)}, and give the surfaces realistic materials. ${surfaces(c)}`;
    }
    return `Paint the masked gray surfaces with photorealistic materials of ${c.look}, continuing the textured ` +
      `surfaces around them seamlessly. Keep every edge and the perspective exactly as they are, with ${light(c)}.` +
      `${c.parts ? ` The masked area shows: ${c.parts}.` : ''} ${surfaces(c)}`;
  },
  /** Caption-style (FLUX 3 Klein, which edits without a mask and is told what the result looks like). */
  caption(c: PromptContext): string {
    if (c.mode === 'roof') {
      return `A photo identical to the first image, except that its plain gray roofs are now ${c.roofLook}, following each ` +
        `roof's exact outline and slope, with ${light(c)}; nothing is added on the roofs.`;
    }
    if (c.mode === 'first') {
      return `A photorealistic photo of ${c.look}, with exactly the camera, perspective and composition of the first ` +
        `image and ${light(c)}. Every gray shape of the first image keeps its exact outline and is now the real ` +
        `surface it is${shapes(c)}. ${surfaces(c)}`;
    }
    return `A photorealistic photo of ${c.look}, with ${light(c)}, identical to the first image in camera, perspective, ` +
      'composition and in every area that already has texture; the plain gray untextured surfaces of the first image now ' +
      `continue those textures seamlessly and keep their exact outlines${shapes(c)}. ${surfaces(c)}`;
  },
};

const size = (s: number) => ({ width: s, height: s });

export const MODELS: Record<string, EditModel> = {
  'flux3-klein': {
    key: 'flux3-klein', label: 'FLUX 3 Klein', endpoint: 'blackforestlabs/flux-3/klein/edit-image', mask: null, price: 0.009,
    input: (i) => ({ prompt: prompts.caption(i.prompt), image_urls: [i.imageUrl],
      image_size: size(i.size), seed: i.seed, output_format: 'png', enable_prompt_expansion: false, num_images: 1 }),
  },
  'fibo2': {
    key: 'fibo2', label: 'Fibo 2 Edit', endpoint: 'bria/fibo-2/edit', mask: 'white', price: 0.04,
    input: (i) => ({ instruction: prompts.instruction(i.prompt), image_urls: [i.imageUrl],
      seed: i.seed, ...(i.maskUrl && i.prompt.mode !== 'first' ? { mask_url: i.maskUrl } : {}) }),
  },
  'ideogram-4.5': {
    key: 'ideogram-4.5', label: 'Ideogram 4.5', endpoint: 'ideogram/v4.5/edit', mask: 'black', price: 0.06,
    input: (i) => ({ image_url: i.imageUrl, prompt: prompts.instruction(i.prompt), quality: 'medium',
      seed: i.seed, num_images: 1, edit_precision: i.prompt.mode === 'first' ? 'regular' : 'high',
      ...(i.maskUrl && i.prompt.mode !== 'first' ? { mask_url: i.maskUrl } : {}) }),
  },
  'nano-banana-2.1': {
    key: 'nano-banana-2.1', label: 'Nano Banana 2.1', endpoint: 'google/nano-banana-2.1/edit', mask: null, price: 0.05,
    input: (i) => ({ prompt: prompts.instruction(i.prompt), image_urls: [i.imageUrl],
      resolution: '1K', aspect_ratio: '1:1', seed: i.seed, output_format: 'png', num_images: 1 }),
  },
  'flux3': {
    key: 'flux3', label: 'FLUX 3', endpoint: 'blackforestlabs/flux-3/edit-image', mask: null, price: 0.048,
    input: (i) => ({ prompt: prompts.instruction(i.prompt), image_urls: [i.imageUrl],
      aspect_ratio: '1:1', resolution: '1k', output_format: 'png', enable_prompt_expansion: false }),
  },
};

/**
 * Material estimation for the baked texture (core/pbr.ts): PATINA predicts normal and roughness maps from an image
 * of at most 2048 px a side. fal lists it per megapixel.
 */
export const MATERIAL_MODEL = { key: 'patina', label: 'PATINA', endpoint: 'fal-ai/patina', price: 0.01, maxSize: 2048 };
export type MaterialMap = 'basecolor' | 'normal' | 'roughness' | 'metalness' | 'height';
