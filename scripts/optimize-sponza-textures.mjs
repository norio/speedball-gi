import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WEBP_EXTENSION = 'EXT_texture_webp';
const BASE_COLOR_QUALITY = 82;
const DATA_TEXTURE_QUALITY = 95;
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const assetDirectory = path.join(repoRoot, 'public/Sponza/glTF');
const gltfPath = path.join(assetDirectory, 'Sponza.gltf');
const gltf = JSON.parse(readFileSync(gltfPath, 'utf8'));

function canDecodeWebp(filePath) {
  if (!existsSync(filePath)) return false;
  const bytes = readFileSync(filePath);
  const hasHeader =
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!hasHeader) return false;

  const decoding = spawnSync('dwebp', ['-quiet', filePath, '-o', devNull], {
    encoding: 'utf8',
  });
  const decodingError = /** @type {NodeJS.ErrnoException | undefined} */ (decoding.error);
  if (decodingError?.code === 'ENOENT') {
    throw new Error('dwebp is required. Install libwebp first (for example: brew install webp).');
  }
  return decoding.status === 0;
}

function hasExpectedBuffer(buffer) {
  const bufferPath = path.resolve(assetDirectory, decodeURIComponent(buffer.uri ?? ''));
  return (
    Boolean(buffer.uri) &&
    path.dirname(bufferPath) === assetDirectory &&
    existsSync(bufferPath) &&
    statSync(bufferPath).size === buffer.byteLength
  );
}

const webpManifestDetected =
  gltf.extensionsRequired?.includes(WEBP_EXTENSION) ||
  gltf.extensionsUsed?.includes(WEBP_EXTENSION) ||
  gltf.images.some((image) => image.mimeType === 'image/webp' || /\.webp$/i.test(image.uri)) ||
  gltf.textures.some((texture) => texture.extensions?.[WEBP_EXTENSION]);

if (webpManifestDetected) {
  const imageUris = gltf.images.map((image) => image.uri);
  const legacyTextures = readdirSync(assetDirectory).filter((name) =>
    /\.(?:jpe?g|png)$/i.test(name),
  );
  const validManifest =
    gltf.extensionsRequired?.includes(WEBP_EXTENSION) &&
    gltf.extensionsUsed?.includes(WEBP_EXTENSION) &&
    new Set(imageUris).size === imageUris.length &&
    gltf.images.every(
      (image) => {
        if (image.mimeType !== 'image/webp' || !/\.webp$/i.test(image.uri)) return false;
        const imagePath = path.resolve(assetDirectory, decodeURIComponent(image.uri));
        return path.dirname(imagePath) === assetDirectory && canDecodeWebp(imagePath);
      },
    ) &&
    gltf.buffers.every(hasExpectedBuffer) &&
    gltf.textures.every((texture) => {
      const source = texture.extensions?.[WEBP_EXTENSION]?.source;
      return (
        texture.source === undefined &&
        Number.isInteger(source) &&
        source >= 0 &&
        source < gltf.images.length
      );
    });
  if (!validManifest) {
    throw new Error(
      'The existing Sponza WebP conversion is incomplete. Restore the asset directory and retry.',
    );
  }
  for (const legacyTexture of legacyTextures) {
    unlinkSync(path.join(assetDirectory, legacyTexture));
  }
  if (legacyTextures.length > 0) {
    console.log(`Removed ${legacyTextures.length} unreferenced legacy texture files.`);
  }
  console.log('Sponza textures are already optimized as WebP.');
  process.exit(0);
}

const cwebpVersion = spawnSync('cwebp', ['-version'], { encoding: 'utf8' });
const cwebpError = /** @type {NodeJS.ErrnoException | undefined} */ (cwebpVersion.error);
if (cwebpError?.code === 'ENOENT') {
  throw new Error('cwebp is required. Install libwebp first (for example: brew install webp).');
}
if (cwebpVersion.status !== 0) {
  throw new Error(cwebpVersion.stderr || 'Could not run cwebp.');
}

for (const [index, texture] of gltf.textures.entries()) {
  if (
    !Number.isInteger(texture.source) ||
    texture.source < 0 ||
    texture.source >= gltf.images.length
  ) {
    throw new Error(`Texture ${index} has an invalid source.`);
  }
}

for (const [index, buffer] of gltf.buffers.entries()) {
  if (!hasExpectedBuffer(buffer)) {
    throw new Error(`Buffer ${index} is missing, outside the asset directory, or has the wrong size.`);
  }
}

const rolesByImage = Array.from({ length: gltf.images.length }, () => new Set());
function addTextureRole(textureInfo, role) {
  if (!textureInfo) return;
  const imageIndex = gltf.textures[textureInfo.index]?.source;
  if (!Number.isInteger(imageIndex)) throw new Error(`Texture ${textureInfo.index} has no source.`);
  rolesByImage[imageIndex].add(role);
}

for (const material of gltf.materials) {
  addTextureRole(material.pbrMetallicRoughness?.baseColorTexture, 'baseColor');
  addTextureRole(material.pbrMetallicRoughness?.metallicRoughnessTexture, 'metallicRoughness');
  addTextureRole(material.normalTexture, 'normal');
  addTextureRole(material.occlusionTexture, 'occlusion');
  addTextureRole(material.emissiveTexture, 'emissive');
}

const sourceImages = gltf.images.map((image, index) => {
  if (!image.uri || !/\.(?:jpe?g|png)$/i.test(image.uri)) {
    throw new Error(`Image ${index} is not a supported JPEG or PNG URI.`);
  }
  const sourcePath = path.resolve(assetDirectory, decodeURIComponent(image.uri));
  if (path.dirname(sourcePath) !== assetDirectory || !existsSync(sourcePath)) {
    throw new Error(`Image ${index} points outside the asset directory or does not exist.`);
  }
  return {
    index,
    image,
    sourcePath,
    hash: createHash('sha256').update(readFileSync(sourcePath)).digest('hex'),
    roles: rolesByImage[index],
  };
});

const groupsByHash = new Map();
for (const source of sourceImages) {
  let group = groupsByHash.get(source.hash);
  if (!group) {
    group = {
      canonical: source,
      sources: [],
      roles: new Set(),
      outputName: `${path.parse(source.image.uri).name}.webp`,
    };
    groupsByHash.set(source.hash, group);
  }
  group.sources.push(source);
  for (const role of source.roles) group.roles.add(role);
}

const optimizedImages = [];
const optimizedIndexBySource = new Map();
for (const group of groupsByHash.values()) {
  const optimizedIndex = optimizedImages.length;
  optimizedImages.push({ mimeType: 'image/webp', uri: group.outputName });
  for (const source of group.sources) optimizedIndexBySource.set(source.index, optimizedIndex);
}

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'speedball-sponza-webp-'));
let optimizedTextureBytes = 0;

try {
  let converted = 0;
  for (const group of groupsByHash.values()) {
    const isBaseColorOnly = group.roles.size === 1 && group.roles.has('baseColor');
    const quality = isBaseColorOnly ? BASE_COLOR_QUALITY : DATA_TEXTURE_QUALITY;
    const outputPath = path.join(temporaryDirectory, group.outputName);
    const args = [
      '-quiet',
      '-mt',
      '-m',
      '6',
      '-q',
      String(quality),
      '-sharp_yuv',
      '-metadata',
      'none',
    ];
    if (/\.png$/i.test(group.canonical.image.uri)) {
      args.push('-alpha_q', '100', '-alpha_method', '1', '-alpha_filter', 'best', '-exact');
    }
    args.push(group.canonical.sourcePath, '-o', outputPath);

    const conversion = spawnSync('cwebp', args, { stdio: 'inherit' });
    if (conversion.status !== 0) {
      throw new Error(`cwebp failed for ${group.canonical.image.uri}.`);
    }
    if (!canDecodeWebp(outputPath)) {
      throw new Error(`Generated WebP could not be decoded for ${group.canonical.image.uri}.`);
    }
    optimizedTextureBytes += statSync(outputPath).size;
    converted += 1;
    console.log(`${converted}/${groupsByHash.size} ${group.outputName} (quality ${quality})`);
  }

  for (const group of groupsByHash.values()) {
    copyFileSync(
      path.join(temporaryDirectory, group.outputName),
      path.join(assetDirectory, group.outputName),
    );
  }

  for (const [index, texture] of gltf.textures.entries()) {
    if (!Number.isInteger(texture.source)) throw new Error(`Texture ${index} has no source.`);
    const optimizedSource = optimizedIndexBySource.get(texture.source);
    if (!Number.isInteger(optimizedSource)) {
      throw new Error(`Texture ${index} could not be mapped to an optimized image.`);
    }
    texture.extensions ??= {};
    texture.extensions[WEBP_EXTENSION] = { source: optimizedSource };
    delete texture.source;
  }

  gltf.images = optimizedImages;
  const extensionsUsed = [...new Set([...(gltf.extensionsUsed ?? []), WEBP_EXTENSION])];
  const extensionsRequired = [...new Set([...(gltf.extensionsRequired ?? []), WEBP_EXTENSION])];
  const { asset, extensionsUsed: _used, extensionsRequired: _required, ...rest } = gltf;
  const optimizedGltf = { asset, extensionsUsed, extensionsRequired, ...rest };
  const temporaryGltfPath = `${gltfPath}.tmp`;
  writeFileSync(temporaryGltfPath, `${JSON.stringify(optimizedGltf, null, 2)}\n`);
  renameSync(temporaryGltfPath, gltfPath);

  for (const source of sourceImages) unlinkSync(source.sourcePath);

  const payloadBytes =
    statSync(gltfPath).size +
    optimizedTextureBytes +
    optimizedGltf.buffers.reduce(
      (total, buffer) => total + statSync(path.join(assetDirectory, buffer.uri)).size,
      0,
    );
  console.log(
    `Converted ${sourceImages.length} source images to ${optimizedImages.length} WebP files.`,
  );
  console.log(`Referenced payload: ${(payloadBytes / 1024 / 1024).toFixed(2)} MiB.`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
