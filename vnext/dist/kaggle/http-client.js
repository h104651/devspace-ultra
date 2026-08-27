"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CloudflareKaggleHttpClient = void 0;
class CloudflareKaggleHttpClient {
    username;
    key;
    isMockMode;
    baseUrl = 'https://www.kaggle.com/api/v1';
    constructor(config = {}) {
        this.username = config.username || '';
        this.key = config.key || '';
        this.isMockMode = config.isMockMode || (!this.username || !this.key);
    }
    hasCredentials() {
        return !!(this.username && this.key);
    }
    getUsername() {
        return this.username || 'kaggle_user';
    }
    setMockMode(mock) {
        this.isMockMode = mock;
    }
    getAuthHeader() {
        const raw = `${this.username}:${this.key}`;
        const encoded = typeof btoa === 'function' ? btoa(raw) : Buffer.from(raw).toString('base64');
        return `Basic ${encoded}`;
    }
    /**
     * Pushes a new kernel to Kaggle via pure HTTP REST API.
     */
    async pushKernel(payload) {
        if (this.isMockMode) {
            return {
                success: true,
                kernelUrl: `https://www.kaggle.com/code/${this.getUsername()}/${payload.kernelSlug}`
            };
        }
        try {
            const url = `${this.baseUrl}/kernels/push`;
            const body = {
                newTitle: payload.title || payload.kernelSlug,
                text: payload.code,
                slug: payload.kernelSlug,
                language: payload.language || 'python',
                kernelType: payload.kernelType || 'script',
                isPrivate: payload.isPrivate !== false,
                enableGpu: !!payload.enableGpu,
                enableInternet: payload.enableInternet !== false,
                datasetDataSources: payload.datasetDataSources || [],
                competitionDataSources: payload.competitionDataSources || [],
                kernelDataSources: payload.kernelDataSources || []
            };
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': this.getAuthHeader()
                },
                body: JSON.stringify(body)
            });
            if (!res.ok) {
                const errorText = await res.text();
                if (res.status === 429 || errorText.includes('quota') || errorText.includes('GPU limit')) {
                    return { success: false, kernelUrl: '', error: 'RESOURCE_QUOTA_EXCEEDED: Kaggle GPU quota limit reached' };
                }
                if (res.status === 401 || res.status === 403) {
                    return { success: false, kernelUrl: '', error: 'KAGGLE_AUTH_FAILED: Invalid Kaggle API credentials in Worker secret' };
                }
                return { success: false, kernelUrl: '', error: `KAGGLE_API_ERROR: HTTP ${res.status}: ${errorText}` };
            }
            return {
                success: true,
                kernelUrl: `https://www.kaggle.com/code/${this.username}/${payload.kernelSlug}`
            };
        }
        catch (err) {
            return {
                success: false,
                kernelUrl: '',
                error: `KAGGLE_NETWORK_ERROR: ${err.message}`
            };
        }
    }
    /**
     * Checks kernel execution status via pure HTTP REST API.
     */
    async getKernelStatus(kernelSlug) {
        if (this.isMockMode) {
            return { status: 'complete', rawMessage: 'Mock execution complete' };
        }
        try {
            const url = `${this.baseUrl}/kernels/status?userName=${encodeURIComponent(this.username)}&kernelSlug=${encodeURIComponent(kernelSlug)}`;
            const res = await fetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': this.getAuthHeader()
                }
            });
            if (!res.ok) {
                const errText = await res.text();
                return { status: 'unknown', rawMessage: `HTTP ${res.status}: ${errText}` };
            }
            const data = await res.json();
            const rawStatus = (data.status || '').toLowerCase();
            let status = 'unknown';
            if (rawStatus.includes('running'))
                status = 'running';
            else if (rawStatus.includes('queued'))
                status = 'queued';
            else if (rawStatus.includes('complete') || rawStatus.includes('finished'))
                status = 'complete';
            else if (rawStatus.includes('error') || rawStatus.includes('failed'))
                status = 'error';
            else if (rawStatus.includes('cancel'))
                status = 'cancelled';
            else if (rawStatus.includes('quota') || rawStatus.includes('limit'))
                status = 'quotaExceeded';
            return {
                status,
                rawMessage: data.failureMessage || data.message || rawStatus
            };
        }
        catch (err) {
            return { status: 'unknown', rawMessage: err.message };
        }
    }
    /**
     * Downloads kernel stdout/stderr and output files via pure HTTP REST API.
     */
    async downloadKernelOutput(kernelSlug) {
        if (this.isMockMode) {
            return {
                success: true,
                files: [
                    {
                        name: 'stdout.log',
                        content: 'Mock Kaggle output stdout: Execution success\nLoss: 0.042',
                        sizeBytes: 52
                    },
                    {
                        name: 'result.json',
                        content: JSON.stringify({ accuracy: 0.985, val_loss: 0.042 }, null, 2),
                        sizeBytes: 46
                    }
                ]
            };
        }
        try {
            const url = `${this.baseUrl}/kernels/output?userName=${encodeURIComponent(this.username)}&kernelSlug=${encodeURIComponent(kernelSlug)}`;
            const res = await fetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': this.getAuthHeader()
                }
            });
            if (!res.ok) {
                const errText = await res.text();
                return { success: false, files: [], error: `Failed to fetch output: HTTP ${res.status}: ${errText}` };
            }
            const data = await res.json();
            const files = [];
            if (data.log) {
                files.push({
                    name: 'stdout.log',
                    content: data.log,
                    sizeBytes: typeof data.log === 'string' ? data.log.length : 0
                });
            }
            if (Array.isArray(data.files)) {
                for (const file of data.files) {
                    files.push({
                        name: file.fileName || file.name || 'output_file',
                        content: file.content,
                        sizeBytes: file.size || 0
                    });
                }
            }
            return { success: true, files };
        }
        catch (err) {
            return { success: false, files: [], error: err.message };
        }
    }
}
exports.CloudflareKaggleHttpClient = CloudflareKaggleHttpClient;
