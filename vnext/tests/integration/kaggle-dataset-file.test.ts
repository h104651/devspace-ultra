import * as assert from 'assert';
import * as crypto from 'crypto';
import { GatewayServer } from '../../src/gateway/server';
import { McpHandlers } from '../../src/mcp/handlers';
import { CloudflareKaggleHttpClient } from '../../src/kaggle/http-client';
import { getCanonicalToolsList } from '../../src/mcp/tools';

export async function runKaggleDatasetFileTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  try {
    const masterSecret = '01234567890123456789012345678901';
    const gateway = new GatewayServer({ masterSecret });
    const kaggleClient = gateway.kaggleBackend.getClient() as CloudflareKaggleHttpClient;
    kaggleClient.setMockMode?.(true);

    const handlers = new McpHandlers(gateway);
    const callerContext = {
      scopes: ['admin', 'kaggle:read', 'tasks:read', 'tasks:submit'],
      subjectId: 'test-kaggle-user'
    };

    // Populate mock datasets
    const owner = 'testuser';
    const slug = 'mock-experiment-dataset';
    const jsonContent = JSON.stringify({ experiment: 'gate2c_9a', accuracy: 0.985, status: 'PASS' }, null, 2);
    const jsonBuf = Buffer.from(jsonContent, 'utf-8');
    const jsonSha256 = crypto.createHash('sha256').update(jsonBuf).digest('hex');

    const multiByteText = 'DevSpace 量化交易阿爾法 🚀 數據測試與多位元字元邊界驗證 UTF-8 Content';
    const multiByteBuf = Buffer.from(multiByteText, 'utf-8');
    const multiByteSha256 = crypto.createHash('sha256').update(multiByteBuf).digest('hex');

    const binaryBuf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x08, 0x00, 0x12, 0x34, 0x56, 0x78]);
    const binarySha256 = crypto.createHash('sha256').update(binaryBuf).digest('hex');

    const v1Files = new Map<string, Buffer>();
    v1Files.set('results/result.json', jsonBuf);
    v1Files.set('docs/multibyte.txt', multiByteBuf);
    v1Files.set('artifacts/data.zip', binaryBuf);

    kaggleClient.registerMockDataset(owner, slug, 1, v1Files, {
      title: 'Mock Experiment Dataset',
      isPrivate: true
    });

    // Version 2 with updated file
    const v2Files = new Map<string, Buffer>();
    const jsonV2Buf = Buffer.from(JSON.stringify({ experiment: 'gate2c_9a_v2', accuracy: 0.992 }), 'utf-8');
    v2Files.set('results/result.json', jsonV2Buf);
    kaggleClient.registerMockDataset(owner, slug, 2, v2Files, {
      title: 'Mock Experiment Dataset',
      isPrivate: true
    });

    // 1. Tool discovery
    const toolCatalog = getCanonicalToolsList();
    const datasetFileTool = toolCatalog.find(t => t.name === 'kaggle_dataset_file');
    assert.ok(datasetFileTool, 'kaggle_dataset_file must be registered in canonical tools list');
    assert.deepStrictEqual(datasetFileTool.inputSchema.required, ['datasetRef', 'relativePath']);
    assert.ok(datasetFileTool.inputSchema.properties.datasetVersion);
    assert.ok(datasetFileTool.inputSchema.properties.expectedSha256);
    assert.ok(datasetFileTool.inputSchema.properties.maxBytes);
    passed++;

    // 2. Successful JSON file read with omitted version (resolves currentVersionNumber = 2)
    const resOmittedVer = await handlers.handleKaggleDatasetFile({
      datasetRef: `${owner}/${slug}`,
      relativePath: 'results/result.json'
    }, callerContext);

    assert.strictEqual(resOmittedVer.datasetRef, `${owner}/${slug}`);
    assert.strictEqual(resOmittedVer.datasetVersion, 2, 'Omitted version should resolve to latest version (2)');
    assert.strictEqual(resOmittedVer.relativePath, 'results/result.json');
    assert.strictEqual(resOmittedVer.contentType, 'application/json');
    assert.strictEqual(resOmittedVer.encoding, 'utf-8');
    assert.strictEqual(resOmittedVer.isText, true);
    assert.strictEqual(resOmittedVer.isTruncated, false);
    assert.strictEqual(resOmittedVer.hashMatch, null, 'hashMatch should be null when expectedSha256 is omitted');
    assert.ok(resOmittedVer.content.includes('gate2c_9a_v2'));
    passed++;

    // 3. Successful JSON file read with explicit version (version = 1)
    const resV1 = await handlers.handleKaggleDatasetFile({
      datasetRef: `${owner}/${slug}`,
      relativePath: 'results/result.json',
      datasetVersion: 1
    }, callerContext);

    assert.strictEqual(resV1.datasetVersion, 1);
    assert.strictEqual(resV1.sha256, jsonSha256);
    assert.strictEqual(resV1.size, jsonBuf.length);
    assert.ok(resV1.content.includes('gate2c_9a'));
    passed++;

    // 4. Exact SHA match (case-insensitive)
    const resShaMatch = await handlers.handleKaggleDatasetFile({
      datasetRef: `${owner}/${slug}`,
      relativePath: 'results/result.json',
      datasetVersion: 1,
      expectedSha256: jsonSha256.toUpperCase()
    }, callerContext);

    assert.strictEqual(resShaMatch.hashMatch, true);
    assert.strictEqual(resShaMatch.sha256, jsonSha256);
    passed++;

    // 5. SHA mismatch
    const fakeSha = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const resShaMismatch = await handlers.handleKaggleDatasetFile({
      datasetRef: `${owner}/${slug}`,
      relativePath: 'results/result.json',
      datasetVersion: 1,
      expectedSha256: fakeSha
    }, callerContext);

    assert.strictEqual(resShaMismatch.hashMatch, false);
    assert.strictEqual(resShaMismatch.sha256, jsonSha256, 'Actual sha256 must remain true calculated hash');
    passed++;

    // 6. File not found in dataset version (exact match only, no substring match)
    await assert.rejects(
      async () => {
        await handlers.handleKaggleDatasetFile({
          datasetRef: `${owner}/${slug}`,
          relativePath: 'results/res', // Substring of results/result.json
          datasetVersion: 1
        }, callerContext);
      },
      (err: any) => err.message.includes('KAGGLE_DATASET_FILE_NOT_FOUND')
    );
    passed++;

    // 7. Dataset not found
    await assert.rejects(
      async () => {
        await handlers.handleKaggleDatasetFile({
          datasetRef: 'testuser/nonexistent-dataset',
          relativePath: 'result.json'
        }, callerContext);
      },
      (err: any) => err.message.includes('KAGGLE_DATASET_NOT_FOUND')
    );
    passed++;

    // 8. Path traversal and malformed path rejection
    const invalidPaths = [
      '../secret.json',
      'results/../../secret.json',
      '/absolute/path.json',
      'C:\\Windows\\system32\\calc.exe',
      'foo\\bar.json',
      '',
      '...'
    ];
    for (const p of invalidPaths) {
      await assert.rejects(
        async () => {
          await handlers.handleKaggleDatasetFile({
            datasetRef: `${owner}/${slug}`,
            relativePath: p,
            datasetVersion: 1
          }, callerContext);
        },
        (err: any) => err.message.includes('INVALID_KAGGLE_DATASET_PATH')
      );
    }
    passed++;

    // 9. Invalid datasetRef format rejection
    const invalidRefs = ['just-slug', 'owner/slug/extra', '', 'invalid space/slug'];
    for (const r of invalidRefs) {
      await assert.rejects(
        async () => {
          await handlers.handleKaggleDatasetFile({
            datasetRef: r,
            relativePath: 'results/result.json'
          }, callerContext);
        },
        (err: any) => err.message.includes('INVALID_KAGGLE_DATASET_REF')
      );
    }
    passed++;

    // 10. maxBytes bounded response with multibyte UTF-8 preservation
    const resTruncated = await handlers.handleKaggleDatasetFile({
      datasetRef: `${owner}/${slug}`,
      relativePath: 'docs/multibyte.txt',
      datasetVersion: 1,
      maxBytes: 20
    }, callerContext);

    assert.strictEqual(resTruncated.isTruncated, true);
    assert.ok(resTruncated.returnedBytes <= 20);
    assert.strictEqual(resTruncated.size, multiByteBuf.length, 'size must report full original byte size');
    assert.strictEqual(resTruncated.sha256, multiByteSha256, 'sha256 must be computed from full original bytes');
    assert.ok(typeof resTruncated.content === 'string');
    assert.ok(!resTruncated.content.includes('\uFFFD'), 'Truncation must not produce corrupt UTF-8 replacement characters');
    passed++;

    // 11. Binary file handling (.zip)
    const resBinary = await handlers.handleKaggleDatasetFile({
      datasetRef: `${owner}/${slug}`,
      relativePath: 'artifacts/data.zip',
      datasetVersion: 1
    }, callerContext);

    assert.strictEqual(resBinary.isText, false);
    assert.strictEqual(resBinary.contentType, 'application/zip');
    assert.strictEqual(resBinary.content, null, 'Binary files must not dump content inline');
    assert.strictEqual(resBinary.size, binaryBuf.length);
    assert.strictEqual(resBinary.sha256, binarySha256);
    passed++;

    // 12. READ ONLY invariant: mutation methods must NOT be called
    let mutationCalled = false;
    const origUploadBlob = kaggleClient.uploadBlob;
    const origCreateDataset = kaggleClient.createDataset;
    const origCreateDatasetVersion = kaggleClient.createDatasetVersion;
    const origPushKernel = kaggleClient.pushKernel;

    kaggleClient.uploadBlob = async () => { mutationCalled = true; throw new Error('MUTATION_FORBIDDEN'); };
    kaggleClient.createDataset = async () => { mutationCalled = true; throw new Error('MUTATION_FORBIDDEN'); };
    kaggleClient.createDatasetVersion = async () => { mutationCalled = true; throw new Error('MUTATION_FORBIDDEN'); };
    kaggleClient.pushKernel = async () => { mutationCalled = true; throw new Error('MUTATION_FORBIDDEN'); };

    try {
      await handlers.handleKaggleDatasetFile({
        datasetRef: `${owner}/${slug}`,
        relativePath: 'results/result.json',
        datasetVersion: 1
      }, callerContext);
      assert.strictEqual(mutationCalled, false, 'No Kaggle mutation methods should be invoked during kaggle_dataset_file');
      passed++;
    } finally {
      kaggleClient.uploadBlob = origUploadBlob;
      kaggleClient.createDataset = origCreateDataset;
      kaggleClient.createDatasetVersion = origCreateDatasetVersion;
      kaggleClient.pushKernel = origPushKernel;
    }

  } catch (err: any) {
    console.error('Kaggle dataset file integration test failed:', err);
    failed++;
  }

  return { passed, failed };
}
