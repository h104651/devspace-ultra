"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ArtifactStore = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const path_sanitizer_1 = require("../security/path-sanitizer");
class ArtifactStore {
    baseDir;
    metadataFile;
    artifacts = new Map();
    maxSizeBytes;
    storageAdapter;
    payloadSink;
    constructor(storageDir, maxSizeBytes = 50 * 1024 * 1024, storageAdapter, payloadSink) {
        this.maxSizeBytes = maxSizeBytes;
        this.storageAdapter = storageAdapter;
        this.payloadSink = payloadSink;
        if (storageDir && storageDir !== ':memory:') {
            this.baseDir = path.join(storageDir, 'artifacts');
            this.metadataFile = path.join(storageDir, 'artifacts_metadata.json');
            try {
                if (!fs.existsSync(this.baseDir)) {
                    fs.mkdirSync(this.baseDir, { recursive: true });
                }
                this.load();
            }
            catch { }
        }
    }
    hydrate(artifacts) {
        for (const meta of artifacts || []) {
            if (meta?.id)
                this.artifacts.set(meta.id, meta);
        }
    }
    load() {
        if (this.metadataFile && fs.existsSync(this.metadataFile)) {
            try {
                const data = JSON.parse(fs.readFileSync(this.metadataFile, 'utf-8'));
                for (const meta of data) {
                    this.artifacts.set(meta.id, meta);
                }
            }
            catch (err) {
                console.error('Failed to load artifact metadata:', err);
            }
        }
    }
    save() {
        if (!this.metadataFile)
            return;
        try {
            const list = Array.from(this.artifacts.values());
            fs.writeFileSync(this.metadataFile, JSON.stringify(list, null, 2), 'utf-8');
        }
        catch (err) {
            console.error('Failed to save artifact metadata:', err);
        }
    }
    saveArtifact(taskId, name, content, type = 'log', mimeType = 'text/plain') {
        const sanitizedName = path_sanitizer_1.PathSanitizer.sanitizeArtifactFilename(name);
        const buffer = Buffer.isBuffer(content)
            ? content
            : content instanceof ArrayBuffer
                ? Buffer.from(new Uint8Array(content))
                : content instanceof Uint8Array
                    ? Buffer.from(content)
                    : Buffer.from(content, 'utf-8');
        if (buffer.length > this.maxSizeBytes) {
            throw new Error(`ARTIFACT_SIZE_EXCEEDED: Artifact ${name} (${buffer.length} bytes) exceeds limit of ${this.maxSizeBytes} bytes`);
        }
        const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
        const id = `art-${crypto.randomBytes(6).toString('hex')}`;
        const storedFileName = `${id}_${sanitizedName}`;
        let storedPath;
        if (this.baseDir) {
            const taskDir = path.join(this.baseDir, taskId);
            try {
                if (!fs.existsSync(taskDir)) {
                    fs.mkdirSync(taskDir, { recursive: true });
                }
                storedPath = path.join(taskDir, storedFileName);
                fs.writeFileSync(storedPath, buffer);
            }
            catch { }
        }
        let preview;
        if (type === 'log' || type === 'stdout' || type === 'stderr' || type === 'json' || type === 'csv') {
            const text = buffer.toString('utf-8');
            preview = text.length > 5000 ? text.substring(0, 5000) + '... [TRUNCATED]' : text;
        }
        const metadata = {
            id,
            taskId,
            name: sanitizedName,
            type,
            mimeType,
            sizeBytes: buffer.length,
            ...(storedPath ? { storedPath } : {}),
            sha256,
            preview,
            createdAt: Date.now()
        };
        this.artifacts.set(id, metadata);
        this.save();
        if (this.storageAdapter) {
            void this.storageAdapter.saveArtifactMetadata(metadata).catch(err => {
                console.error(`Failed to persist artifact metadata ${id}:`, err);
            });
        }
        if (this.payloadSink) {
            const bytes = Uint8Array.from(buffer);
            try {
                const pending = this.payloadSink(metadata, bytes);
                if (pending && typeof pending.catch === 'function') {
                    void pending.catch(err => console.error(`Failed to persist artifact payload ${id}:`, err));
                }
            }
            catch (err) {
                console.error(`Failed to persist artifact payload ${id}:`, err);
            }
        }
        return metadata;
    }
    getArtifactMetadata(artifact) {
        const artifactId = typeof artifact === 'string' ? artifact : artifact?.id;
        return artifactId ? this.artifacts.get(artifactId) : undefined;
    }
    getTaskArtifacts(taskId) {
        const list = [];
        for (const art of this.artifacts.values()) {
            if (art.taskId === taskId)
                list.push(art);
        }
        return list.sort((a, b) => a.createdAt - b.createdAt);
    }
    listArtifacts() {
        return Array.from(this.artifacts.values()).sort((a, b) => b.createdAt - a.createdAt);
    }
    readArtifactContent(artifactId) {
        const meta = this.artifacts.get(artifactId);
        if (!meta?.storedPath || !fs.existsSync(meta.storedPath)) {
            return undefined;
        }
        return fs.readFileSync(meta.storedPath);
    }
    // Compatibility alias retained for the legacy/local Express gateway. The
    // Cloudflare path reads payloads from R2 directly, while local file-backed
    // runtimes historically called getArtifactContent().
    getArtifactContent(artifactId) {
        return this.readArtifactContent(artifactId);
    }
}
exports.ArtifactStore = ArtifactStore;
