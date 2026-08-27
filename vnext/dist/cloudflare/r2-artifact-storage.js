"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CloudflareR2ArtifactStorage = exports.INLINE_SIZE_THRESHOLD_BYTES = void 0;
exports.INLINE_SIZE_THRESHOLD_BYTES = 256 * 1024;
const ALWAYS_OBJECT_STORAGE = new Set([
    'binary', 'image', 'archive', 'notebook'
]);
function safeFilename(filename) {
    return filename.replace(/[\\/\0]/g, '_').slice(0, 180) || 'artifact.bin';
}
class CloudflareR2ArtifactStorage {
    r2;
    constructor(r2Bucket) {
        this.r2 = r2Bucket;
    }
    objectKey(metadata) {
        return `tasks/${metadata.taskId}/${metadata.id}_${safeFilename(metadata.name)}`;
    }
    async saveArtifact(taskId, filename, content, type = 'binary', mimeType) {
        const id = `art-${crypto.randomUUID()}`;
        const rawBuffer = typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content);
        const hashBuffer = await crypto.subtle.digest('SHA-256', rawBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const sha256 = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        let preview;
        if (['log', 'stdout', 'stderr', 'json', 'csv'].includes(type)) {
            const text = typeof content === 'string' ? content : new TextDecoder().decode(rawBuffer);
            preview = text.length > 5000 ? text.substring(0, 5000) + '... [truncated]' : text;
        }
        const metadata = {
            id,
            taskId,
            name: safeFilename(filename),
            type,
            mimeType,
            sizeBytes: rawBuffer.byteLength,
            sha256,
            preview,
            createdAt: Date.now()
        };
        const r2Key = await this.saveArtifactPayload(metadata, rawBuffer);
        return { metadata, r2Key };
    }
    async saveArtifactPayload(metadata, content) {
        if (!this.r2)
            return undefined;
        const rawBuffer = typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content);
        const shouldStore = rawBuffer.byteLength >= exports.INLINE_SIZE_THRESHOLD_BYTES || ALWAYS_OBJECT_STORAGE.has(metadata.type);
        if (!shouldStore)
            return undefined;
        const key = this.objectKey(metadata);
        await this.r2.put(key, rawBuffer, {
            httpMetadata: metadata.mimeType ? { contentType: metadata.mimeType } : undefined,
            customMetadata: {
                taskId: metadata.taskId,
                artifactId: metadata.id,
                sha256: metadata.sha256,
                originalName: metadata.name
            }
        });
        return key;
    }
    async getArtifactContent(r2Key) {
        if (!this.r2)
            return null;
        const obj = await this.r2.get(r2Key);
        if (!obj)
            return null;
        return obj.arrayBuffer();
    }
    async getArtifact(metadata) {
        return this.getArtifactContent(this.objectKey(metadata));
    }
}
exports.CloudflareR2ArtifactStorage = CloudflareR2ArtifactStorage;
