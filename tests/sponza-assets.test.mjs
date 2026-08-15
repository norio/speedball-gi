import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WEBP_EXTENSION = 'EXT_texture_webp';
const EXPECTED_TEXTURE_MAPPING_SHA256 =
  'f0d238dc41883b42d850b7ad9c3dce36d2e6a6744a19a62e8a7ebda376c9823f';
const EXPECTED_WEBP_ASSETS_SHA256 =
  '64ed131888fc06dca020830e6a8eff9a2f1817ab582035c4adfa3251e825f430';
const EXPECTED_BUFFER_SHA256 =
  'fdbdbfb6a76edeb6626f28a1401bc1536bb1c864131a64e90fbc3df2d2d191bd';
const MAX_PAYLOAD_BYTES = 30 * 1024 * 1024;
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const assetDirectory = path.join(repoRoot, 'public/Sponza/glTF');
const gltfPath = path.join(assetDirectory, 'Sponza.gltf');
const gltf = JSON.parse(readFileSync(gltfPath, 'utf8'));

function resolveAssetUri(uri, label) {
  assert.equal(typeof uri, 'string', `${label} に URI がありません`);
  const filePath = path.resolve(assetDirectory, decodeURIComponent(uri));
  assert.equal(path.dirname(filePath), assetDirectory, `${label} が asset directory の外を参照しています`);
  return filePath;
}

function readUint24LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readWebpMetadata(filePath) {
  const bytes = readFileSync(filePath);
  assert.ok(bytes.length >= 12, `${path.basename(filePath)} が空か切り詰められています`);
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF', `${path.basename(filePath)} は RIFF ではありません`);
  assert.equal(bytes.toString('ascii', 8, 12), 'WEBP', `${path.basename(filePath)} は WebP ではありません`);
  assert.equal(bytes.readUInt32LE(4) + 8, bytes.length, `${path.basename(filePath)} の RIFF サイズが不正です`);

  let extendedDimensions;
  let frameDimensions;
  let hasAlphaChunk = false;
  let extendedAlpha = false;
  let losslessAlpha = false;
  let offset = 12;
  for (; offset + 8 <= bytes.length; ) {
    const chunkType = bytes.toString('ascii', offset, offset + 4);
    const chunkSize = bytes.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + chunkSize;
    assert.ok(dataEnd <= bytes.length, `${path.basename(filePath)} の ${chunkType} chunk が不正です`);

    if (chunkType === 'VP8X') {
      assert.ok(chunkSize >= 10, `${path.basename(filePath)} の VP8X chunk が短すぎます`);
      extendedAlpha = (bytes[dataOffset] & 0x10) !== 0;
      extendedDimensions = {
        width: readUint24LE(bytes, dataOffset + 4) + 1,
        height: readUint24LE(bytes, dataOffset + 7) + 1,
      };
    } else if (chunkType === 'ALPH') {
      assert.ok(chunkSize > 0, `${path.basename(filePath)} の ALPH chunk が空です`);
      hasAlphaChunk = true;
    } else if (chunkType === 'VP8 ') {
      assert.ok(chunkSize >= 10, `${path.basename(filePath)} の VP8 chunk が短すぎます`);
      assert.deepEqual(
        [...bytes.subarray(dataOffset + 3, dataOffset + 6)],
        [0x9d, 0x01, 0x2a],
        `${path.basename(filePath)} の VP8 frame header が不正です`,
      );
      frameDimensions = {
        width: bytes.readUInt16LE(dataOffset + 6) & 0x3fff,
        height: bytes.readUInt16LE(dataOffset + 8) & 0x3fff,
      };
    } else if (chunkType === 'VP8L') {
      assert.ok(chunkSize >= 5, `${path.basename(filePath)} の VP8L chunk が短すぎます`);
      assert.equal(bytes[dataOffset], 0x2f, `${path.basename(filePath)} の VP8L signature が不正です`);
      const sizeBits = bytes.readUInt32LE(dataOffset + 1);
      losslessAlpha = ((sizeBits >>> 28) & 1) === 1;
      frameDimensions = {
        width: (sizeBits & 0x3fff) + 1,
        height: ((sizeBits >>> 14) & 0x3fff) + 1,
      };
    }
    offset = dataEnd + (chunkSize & 1);
  }

  assert.equal(offset, bytes.length, `${path.basename(filePath)} の chunk 境界が不正です`);
  assert.ok(frameDimensions, `${path.basename(filePath)} に画像 chunk がありません`);
  if (extendedDimensions) {
    assert.deepEqual(
      frameDimensions,
      extendedDimensions,
      `${path.basename(filePath)} の canvas と frame の寸法が一致しません`,
    );
  }
  assert.equal(
    extendedAlpha,
    hasAlphaChunk,
    `${path.basename(filePath)} の alpha flag と ALPH chunk が一致しません`,
  );
  return {
    ...frameDimensions,
    hasAlpha: losslessAlpha || (extendedAlpha && hasAlphaChunk),
  };
}

test('Sponza は WebP テクスチャだけを参照する', () => {
  assert.ok(gltf.extensionsUsed?.includes(WEBP_EXTENSION));
  assert.ok(gltf.extensionsRequired?.includes(WEBP_EXTENSION));

  for (const [index, texture] of gltf.textures.entries()) {
    assert.equal(texture.source, undefined, `texture ${index} にフォールバック画像が残っています`);
    const source = texture.extensions?.[WEBP_EXTENSION]?.source;
    assert.ok(Number.isInteger(source), `texture ${index} に WebP source がありません`);
    assert.ok(source >= 0 && source < gltf.images.length, `texture ${index} の source が範囲外です`);
  }
  const referencedImages = new Set(
    gltf.textures.map((texture) => texture.extensions[WEBP_EXTENSION].source),
  );
  assert.equal(referencedImages.size, gltf.images.length, '未使用の WebP 画像が残っています');
  const textureMapping = gltf.textures
    .map((texture) => gltf.images[texture.extensions[WEBP_EXTENSION].source].uri)
    .join('\n');
  assert.equal(
    createHash('sha256').update(textureMapping).digest('hex'),
    EXPECTED_TEXTURE_MAPPING_SHA256,
    'テクスチャと画像の対応が意図した Sponza マッピングから変わっています',
  );

  const alphaMaskedImages = new Set(
    gltf.materials
      .filter((material) => material.alphaMode === 'MASK')
      .map((material) => {
        const textureIndex = material.pbrMetallicRoughness?.baseColorTexture?.index;
        return gltf.textures[textureIndex]?.extensions?.[WEBP_EXTENSION]?.source;
      }),
  );
  assert.equal(alphaMaskedImages.size, 3, 'alpha MASK の画像数が変わっています');

  const webpAssetsHash = createHash('sha256');
  const imageUris = gltf.images.map((image, index) => {
    assert.equal(image.mimeType, 'image/webp', `image ${index} の MIME type が WebP ではありません`);
    assert.match(image.uri, /\.webp$/i, `image ${index} の拡張子が WebP ではありません`);
    const imagePath = resolveAssetUri(image.uri, `image ${index}`);
    assert.ok(existsSync(imagePath), `${image.uri} がありません`);
    const metadata = readWebpMetadata(imagePath);
    const expectedSize = image.uri === 'white.webp' ? 4 : 1024;
    assert.equal(metadata.width, expectedSize);
    assert.equal(metadata.height, expectedSize);
    if (alphaMaskedImages.has(index)) {
      assert.ok(metadata.hasAlpha, `${image.uri} に alpha がありません`);
    }
    webpAssetsHash.update(image.uri);
    webpAssetsHash.update('\0');
    webpAssetsHash.update(readFileSync(imagePath));
    return image.uri;
  });
  assert.equal(new Set(imageUris).size, imageUris.length, '重複した画像 URI が残っています');
  assert.equal(
    webpAssetsHash.digest('hex'),
    EXPECTED_WEBP_ASSETS_SHA256,
    'WebP 画像が検証済みの内容から変わっています',
  );

  const storedWebpFiles = readdirSync(assetDirectory)
    .filter((name) => /\.webp$/i.test(name))
    .sort();
  assert.deepEqual(storedWebpFiles, [...imageUris].sort(), '参照されていない WebP 画像があります');

  const legacyTextures = readdirSync(assetDirectory).filter((name) => /\.(?:jpe?g|png)$/i.test(name));
  assert.deepEqual(legacyTextures, []);
});

test('Sponza の参照ペイロードは 30 MiB 以下', () => {
  assert.equal(gltf.buffers.length, 1, 'Sponza の buffer 数が変わっています');
  const bufferPaths = gltf.buffers.map((buffer, index) => {
    const bufferPath = resolveAssetUri(buffer.uri, `buffer ${index}`);
    assert.ok(existsSync(bufferPath), `${buffer.uri} がありません`);
    assert.equal(statSync(bufferPath).size, buffer.byteLength, `${buffer.uri} のサイズが不正です`);
    assert.equal(
      createHash('sha256').update(readFileSync(bufferPath)).digest('hex'),
      EXPECTED_BUFFER_SHA256,
      `${buffer.uri} が検証済みの内容から変わっています`,
    );
    return bufferPath;
  });
  const referencedFiles = [
    gltfPath,
    ...bufferPaths,
    ...gltf.images.map((image, index) => resolveAssetUri(image.uri, `image ${index}`)),
  ];
  const payloadBytes = referencedFiles.reduce((total, file) => total + statSync(file).size, 0);

  assert.ok(
    payloadBytes <= MAX_PAYLOAD_BYTES,
    `${(payloadBytes / 1024 / 1024).toFixed(2)} MiB が 30 MiB の上限を超えています`,
  );
});
