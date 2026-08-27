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
exports.KaggleClient = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const child_process_1 = require("child_process");
const notebook_builder_1 = require("./notebook-builder");
class KaggleClient {
    credentials;
    isMockMode;
    constructor(credentials, isMockMode = false) {
        this.credentials = credentials || this.detectCredentials();
        this.isMockMode = isMockMode || !this.credentials;
    }
    detectCredentials() {
        if (process.env.KAGGLE_USERNAME && process.env.KAGGLE_KEY) {
            return {
                username: process.env.KAGGLE_USERNAME,
                key: process.env.KAGGLE_KEY
            };
        }
        const homeKaggle = path.join(os.homedir(), '.kaggle', 'kaggle.json');
        if (fs.existsSync(homeKaggle)) {
            try {
                const data = JSON.parse(fs.readFileSync(homeKaggle, 'utf-8'));
                if (data.username && data.key) {
                    return { username: data.username, key: data.key };
                }
            }
            catch { }
        }
        return undefined;
    }
    hasCredentials() {
        return !!this.credentials;
    }
    getUsername() {
        return this.credentials?.username || 'kaggle_user';
    }
    setMockMode(mock) {
        this.isMockMode = mock;
    }
    /**
     * Pushes a new kernel to Kaggle.
     */
    async pushKernel(workDir, payload) {
        if (this.isMockMode) {
            return {
                success: true,
                kernelUrl: `https://www.kaggle.com/code/${this.getUsername()}/${payload.kernelSlug}`
            };
        }
        const username = this.getUsername();
        const metadata = notebook_builder_1.NotebookBuilder.buildMetadata(username, payload);
        if (!fs.existsSync(workDir)) {
            fs.mkdirSync(workDir, { recursive: true });
        }
        fs.writeFileSync(path.join(workDir, 'kernel-metadata.json'), JSON.stringify(metadata, null, 2));
        const codeFileName = metadata.code_file;
        if (metadata.kernel_type === 'notebook' && !payload.code.trim().startsWith('{')) {
            const ipynb = notebook_builder_1.NotebookBuilder.codeToIpynb(payload.code);
            fs.writeFileSync(path.join(workDir, codeFileName), ipynb);
        }
        else {
            fs.writeFileSync(path.join(workDir, codeFileName), payload.code);
        }
        return new Promise((resolve) => {
            const env = {
                ...process.env,
                KAGGLE_USERNAME: this.credentials?.username,
                KAGGLE_KEY: this.credentials?.key
            };
            (0, child_process_1.exec)(`kaggle kernels push -p "${workDir}"`, { env }, (error, stdout, stderr) => {
                const out = `${stdout} ${stderr}`;
                if (error || out.toLowerCase().includes('error') || out.toLowerCase().includes('403') || out.toLowerCase().includes('401')) {
                    if (out.includes('quota') || out.includes('GPU limit') || out.includes('exceeded')) {
                        resolve({ success: false, kernelUrl: '', error: 'RESOURCE_QUOTA_EXCEEDED: Kaggle GPU quota limit reached' });
                    }
                    else if (out.includes('401') || out.includes('Unauthorized') || out.includes('credentials')) {
                        resolve({ success: false, kernelUrl: '', error: 'KAGGLE_AUTH_FAILED: Invalid Kaggle API credentials' });
                    }
                    else {
                        resolve({ success: false, kernelUrl: '', error: `KAGGLE_PUSH_FAILED: ${out.trim() || error?.message}` });
                    }
                }
                else {
                    resolve({
                        success: true,
                        kernelUrl: `https://www.kaggle.com/code/${username}/${payload.kernelSlug}`
                    });
                }
            });
        });
    }
    /**
     * Checks current execution status of a kernel.
     */
    async getKernelStatus(kernelSlug) {
        if (this.isMockMode) {
            return { status: 'complete', rawMessage: 'Mock execution finished successfully' };
        }
        const username = this.getUsername();
        const fullSlug = `${username}/${kernelSlug}`;
        return new Promise((resolve) => {
            const env = {
                ...process.env,
                KAGGLE_USERNAME: this.credentials?.username,
                KAGGLE_KEY: this.credentials?.key
            };
            (0, child_process_1.exec)(`kaggle kernels status ${fullSlug}`, { env }, (error, stdout, stderr) => {
                const out = `${stdout} ${stderr}`.trim();
                const lower = out.toLowerCase();
                if (lower.includes('running')) {
                    resolve({ status: 'running', rawMessage: out });
                }
                else if (lower.includes('queued')) {
                    resolve({ status: 'queued', rawMessage: out });
                }
                else if (lower.includes('complete') || lower.includes('finished')) {
                    resolve({ status: 'complete', rawMessage: out });
                }
                else if (lower.includes('error') || lower.includes('failed')) {
                    resolve({ status: 'error', rawMessage: out });
                }
                else if (lower.includes('quota') || lower.includes('limit')) {
                    resolve({ status: 'quotaExceeded', rawMessage: out });
                }
                else if (lower.includes('cancel')) {
                    resolve({ status: 'cancelled', rawMessage: out });
                }
                else {
                    resolve({ status: 'unknown', rawMessage: out });
                }
            });
        });
    }
    /**
     * Fetches kernel outputs and log files into a local output directory.
     */
    async downloadKernelOutput(kernelSlug, outputDir) {
        if (this.isMockMode) {
            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir, { recursive: true });
            }
            fs.writeFileSync(path.join(outputDir, 'stdout.log'), 'Mock Kaggle output stdout: Execution success\nEpoch 1/1 - loss: 0.042');
            fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify({ metrics: { accuracy: 0.985, val_loss: 0.042 } }, null, 2));
            return {
                success: true,
                files: [path.join(outputDir, 'stdout.log'), path.join(outputDir, 'result.json')]
            };
        }
        const username = this.getUsername();
        const fullSlug = `${username}/${kernelSlug}`;
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        return new Promise((resolve) => {
            const env = {
                ...process.env,
                KAGGLE_USERNAME: this.credentials?.username,
                KAGGLE_KEY: this.credentials?.key
            };
            (0, child_process_1.exec)(`kaggle kernels output ${fullSlug} -p "${outputDir}"`, { env }, (error, stdout, stderr) => {
                if (error) {
                    resolve({ success: false, files: [], error: `KAGGLE_OUTPUT_ERROR: ${stderr || error.message}` });
                }
                else {
                    try {
                        const files = fs.readdirSync(outputDir).map(f => path.join(outputDir, f));
                        resolve({ success: true, files });
                    }
                    catch (e) {
                        resolve({ success: false, files: [], error: e.message });
                    }
                }
            });
        });
    }
    async listProjects(params = {}) {
        const mockProjects = [
            {
                ref: `${this.getUsername()}/astor-tuneup`,
                slug: 'astor-tuneup',
                owner: this.getUsername(),
                title: 'Astor TuneUp',
                kernelType: 'notebook',
                language: 'python',
                lastRunTime: '2026-08-24T06:18:15.053Z',
                isPrivate: true
            },
            {
                ref: `${this.getUsername()}/devspace-project-control-e2e`,
                slug: 'devspace-project-control-e2e',
                owner: this.getUsername(),
                title: 'DevSpace Project Control E2E',
                kernelType: 'script',
                language: 'python',
                lastRunTime: '2026-08-27T04:20:00.000Z',
                isPrivate: true
            }
        ];
        const search = (params.search || '').toLowerCase();
        if (!search)
            return mockProjects;
        return mockProjects.filter(p => p.title.toLowerCase().includes(search) || p.slug.toLowerCase().includes(search));
    }
    async pullProject(owner, slug, version) {
        const isNotebook = slug.includes('tuneup') || slug.includes('notebook');
        const mockSource = isNotebook
            ? JSON.stringify({
                cells: [
                    { cell_type: 'code', execution_count: 1, metadata: {}, outputs: [], source: ['print("Astor TuneUp initialized")\n'] }
                ],
                metadata: { language_info: { name: 'python' }, kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
                nbformat: 4,
                nbformat_minor: 5
            }, null, 1)
            : 'print("Mock script project source")\n';
        const mockMetadata = {
            title: slug.includes('tuneup') ? 'Astor TuneUp' : slug,
            slug,
            author: owner,
            kernelType: isNotebook ? 'notebook' : 'script',
            language: 'python',
            isPrivate: true,
            enableGpu: isNotebook,
            enableInternet: true,
            machineShape: isNotebook ? 'NvidiaTeslaT4' : undefined,
            datasetDataSources: isNotebook ? ['astorhsu/astor-gate2c-8g-kaggle-package'] : [],
            competitionDataSources: [],
            kernelDataSources: [],
            modelSources: []
        };
        return { metadata: mockMetadata, source: mockSource };
    }
    async getProjectOutputFiles(owner, slug) {
        return {
            files: [
                { name: 'stdout.log', size: 1024, creationTime: new Date().toISOString() },
                { name: 'metrics.json', size: 128, creationTime: new Date().toISOString() }
            ],
            log: 'Mock log line 1\nMock log line 2'
        };
    }
    async getProjectLogs(owner, slug) {
        return { logs: ['Mock log line 1', 'Mock log line 2'], available: true };
    }
}
exports.KaggleClient = KaggleClient;
