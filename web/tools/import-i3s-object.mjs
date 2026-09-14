#!/usr/bin/env node
/** Convert one public I3S 3D-object node to a footprint-anchored GLB.
 *
 * loaders.gl owns I3S schema and geometry decoding. This adapter deliberately requests
 * raw vertex offsets because some ArcGIS services (including Richmond's) use a
 * projected node CRS that loaders.gl's default lon/lat transform cannot infer.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from '@loaders.gl/core';
import { COORDINATE_SYSTEM, I3SContentLoader, I3SLoader } from '@loaders.gl/i3s';
import proj4 from 'proj4';

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`unexpected argument: ${argv[i]}`);
    const key = argv[i].slice(2);
    if (key === 'no-texture') out[key] = true;
    else out[key] = argv[++i];
  }
  return out;
}

function epsg(value) {
  const match = String(value ?? '').match(/(?:EPSG(?::|\/0\/)|wkid[=:]?)(\d+)/i);
  return match ? `EPSG:${match[1] === '102100' ? '3857' : match[1]}` : value;
}

function projection(value) {
  const crs = epsg(value);
  const code = Number(String(crs).split(':')[1]);
  if (code >= 32601 && code <= 32660) proj4.defs(crs, `+proj=utm +zone=${code - 32600} +datum=WGS84 +units=m +no_defs`);
  if (code >= 32701 && code <= 32760) proj4.defs(crs, `+proj=utm +zone=${code - 32700} +south +datum=WGS84 +units=m +no_defs`);
  return crs;
}

const pad4 = (bytes, fill = 0) => {
  const out = Buffer.alloc(Math.ceil(bytes.length / 4) * 4, fill);
  Buffer.from(bytes).copy(out);
  return out;
};

function mimeType(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  throw new Error('only JPEG and PNG I3S textures can be embedded in GLB');
}

export function bakeAtlasUvs(texCoords, regions) {
  const out = new Float32Array(texCoords.length);
  for (let i = 0, v = 0; i < texCoords.length; i += 2, v += 4) {
    if (regions) {
      const u0 = regions[v] / 65535, v0 = regions[v + 1] / 65535;
      const u1 = regions[v + 2] / 65535, v1 = regions[v + 3] / 65535;
      out[i] = u0 + texCoords[i] * (u1 - u0);
      out[i + 1] = v0 + texCoords[i + 1] * (v1 - v0);
    } else {
      out[i] = texCoords[i]; out[i + 1] = texCoords[i + 1];
    }
  }
  return out;
}

export function localize(attributes, nodeOrigin, sourceCrs, targetCrs, anchor, scale = [1, 1, 1]) {
  const raw = attributes.positions.value;
  const position = new Float32Array(raw.length);
  const projected = new Float64Array(raw.length);
  let base = Infinity;
  for (let i = 0; i < raw.length; i += 3) {
    const [x, y] = proj4(sourceCrs, targetCrs, [nodeOrigin[0] + raw[i] * scale[0], nodeOrigin[1] + raw[i + 1] * scale[1]]);
    const z = nodeOrigin[2] + raw[i + 2] * scale[2];
    projected.set([x, y, z], i); base = Math.min(base, z);
  }
  for (let i = 0; i < projected.length; i += 3) {
    position.set([projected[i] - anchor[0], projected[i + 2] - base, anchor[1] - projected[i + 1]], i);
  }

  let normal;
  if (attributes.normals) {
    const rawNormal = attributes.normals.value;
    normal = new Float32Array(rawNormal.length);
    const step = String(sourceCrs).endsWith(':4326') ? 1e-5 : 1;
    const o = proj4(sourceCrs, targetCrs, nodeOrigin.slice(0, 2));
    const px = proj4(sourceCrs, targetCrs, [nodeOrigin[0] + step, nodeOrigin[1]]);
    const py = proj4(sourceCrs, targetCrs, [nodeOrigin[0], nodeOrigin[1] + step]);
    const ex = [px[0] - o[0], px[1] - o[1]], ey = [py[0] - o[0], py[1] - o[1]];
    const exl = Math.hypot(...ex), eyl = Math.hypot(...ey);
    ex[0] /= exl; ex[1] /= exl; ey[0] /= eyl; ey[1] /= eyl;
    for (let i = 0; i < rawNormal.length; i += 3) {
      const east = rawNormal[i] * ex[0] + rawNormal[i + 1] * ey[0];
      const north = rawNormal[i] * ex[1] + rawNormal[i + 1] * ey[1];
      const up = rawNormal[i + 2], length = Math.hypot(east, north, up) || 1;
      normal.set([east / length, up / length, -north / length], i);
    }
  }
  return { position, normal, base };
}

export function buildGlb({ position, normal, color, uv, texture, name = 'I3S object', extras = {} }) {
  const chunks = [], views = [], accessors = [];
  const addView = (bytes, target) => {
    const offset = chunks.reduce((n, b) => n + b.length, 0), raw = Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length);
    chunks.push(pad4(raw));
    views.push({ buffer: 0, byteOffset: offset, byteLength: raw.length, ...(target ? { target } : {}) });
    return views.length - 1;
  };
  const addAccessor = (bytes, componentType, type, count, normalized = false, bounds = false) => {
    const view = addView(bytes, 34962), item = { bufferView: view, componentType, count, type };
    if (normalized) item.normalized = true;
    if (bounds) {
      const size = type === 'VEC3' ? 3 : 2, min = Array(size).fill(Infinity), max = Array(size).fill(-Infinity);
      for (let i = 0; i < bytes.length; i++) { const k = i % size; min[k] = Math.min(min[k], bytes[i]); max[k] = Math.max(max[k], bytes[i]); }
      item.min = min; item.max = max;
    }
    accessors.push(item); return accessors.length - 1;
  };
  const attributes = { POSITION: addAccessor(position, 5126, 'VEC3', position.length / 3, false, true) };
  if (normal) attributes.NORMAL = addAccessor(normal, 5126, 'VEC3', normal.length / 3);
  if (uv && texture) attributes.TEXCOORD_0 = addAccessor(uv, 5126, 'VEC2', uv.length / 2);
  else if (color) attributes.COLOR_0 = addAccessor(color, 5121, 'VEC4', color.length / 4, true);

  const doc = {
    asset: { version: '2.0', generator: 'web/tools/import-i3s-object.mjs', extras },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name }],
    meshes: [{ name, primitives: [{ attributes, mode: 4, material: 0 }] }],
    materials: [{ name: `${name} material`, pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.9 }, doubleSided: true }],
    buffers: [], bufferViews: views, accessors,
  };
  if (uv && texture) {
    const imageView = addView(texture);
    doc.images = [{ bufferView: imageView, mimeType: mimeType(texture) }];
    doc.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }];
    doc.textures = [{ sampler: 0, source: 0 }];
    doc.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 };
  }
  const binary = Buffer.concat(chunks);
  doc.buffers.push({ byteLength: binary.length });
  const json = pad4(Buffer.from(JSON.stringify(doc)), 0x20);
  const body = Buffer.concat([Buffer.from(Uint32Array.of(json.length).buffer), Buffer.from('JSON'), json,
    Buffer.from(Uint32Array.of(binary.length).buffer), Buffer.from('BIN\0'), binary]);
  return Buffer.concat([Buffer.from('glTF'), Buffer.from(Uint32Array.of(2, 12 + body.length).buffer), body]);
}

export async function convertI3sNode(options) {
  const layerUrl = options.layer.replace(/\/$/, '');
  const nodeUrl = `${layerUrl}/nodes/${options.node}`;
  const tileset = await load(layerUrl, I3SLoader, { i3s: { loadContent: false } });
  const node = await (await fetch(nodeUrl)).json();
  const sharedUrl = new URL((node.sharedResource?.href ?? './shared').replace(/^\.\//, ''), `${nodeUrl}/`).href;
  const shared = await (await fetch(sharedUrl)).json();
  const geometryHref = node.geometryData?.[0]?.href;
  if (!geometryHref) throw new Error(`node ${options.node} has no directly addressable geometry resource`);
  const geometryUrl = new URL(geometryHref.replace(/^\.\//, ''), `${nodeUrl}/`).href;
  const materialDefinition = Object.values(shared.materialDefinitions ?? {})[0];
  const tile = { mbs: node.mbs, contentUrl: geometryUrl, materialDefinition, isDracoGeometry: false };
  const content = await load(geometryUrl, I3SContentLoader, { i3s: {
    tile, tileset, decodeTextures: false, coordinateSystem: COORDINATE_SYSTEM.LNGLAT_OFFSETS,
  } });
  if (!content?.attributes?.positions) throw new Error(`failed to decode node ${options.node}`);

  const declared = tileset.store?.vertexCRS ?? tileset.store?.indexCRS ?? `EPSG:${tileset.spatialReference?.latestWkid ?? tileset.spatialReference?.wkid}`;
  const sourceCrs = projection(options.sourceCrs ?? declared), targetCrs = projection(options.targetCrs);
  const m = content.modelMatrix;
  const localized = localize(content.attributes, node.mbs, sourceCrs, targetCrs, options.anchor, [m[0], m[5], m[10]]);
  let texture = null, uv = null;
  if (!options.noTexture && content.attributes.texCoords && node.textureData?.length) {
    const preferred = node.textureData.find((r) => !/_0_[147]$/.test(r.href)) ?? node.textureData[0];
    const textureUrl = new URL(preferred.href.replace(/^\.\//, ''), `${nodeUrl}/`).href;
    texture = Buffer.from(await (await fetch(textureUrl)).arrayBuffer());
    uv = bakeAtlasUvs(content.attributes.texCoords.value, content.attributes.uvRegions?.value);
  }
  const glb = buildGlb({ position: localized.position, normal: localized.normal,
    color: content.attributes.colors?.value, uv, texture, name: options.name,
    extras: { source: layerUrl, node: String(options.node), sourceCrs, targetCrs, anchor: options.anchor, baseZ: localized.base } });
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, glb);
  return { vertices: localized.position.length / 3, triangles: localized.position.length / 9,
    textured: Boolean(texture), bytes: glb.length, baseZ: localized.base };
}

async function main() {
  const a = args(process.argv.slice(2));
  if (!a.layer || !a.node || !a.output || !a.anchor || !a['target-crs']) {
    throw new Error('usage: import-i3s-object.mjs --layer URL --node ID --target-crs EPSG:32618 --anchor X,Y --output model.glb [--name NAME] [--source-crs CRS] [--no-texture]');
  }
  const anchor = a.anchor.split(',').map(Number);
  if (anchor.length !== 2 || !anchor.every(Number.isFinite)) throw new Error('--anchor must be X,Y');
  const result = await convertI3sNode({ layer: a.layer, node: a.node, targetCrs: a['target-crs'],
    sourceCrs: a['source-crs'], anchor, output: a.output, name: a.name ?? `I3S node ${a.node}`,
    noTexture: a['no-texture'] });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  main().catch((error) => { console.error(error.stack ?? error); process.exitCode = 1; });
}
