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
            const fullSlug = payload.kernelSlug.includes('/') ? payload.kernelSlug : `${this.username}/${payload.kernelSlug}`;
            const rawSlug = payload.kernelSlug.includes('/') ? payload.kernelSlug.split('/')[1] : payload.kernelSlug;
            const rawTitle = payload.title || rawSlug;
            const title = rawTitle.length > 50 ? rawTitle.substring(0, 50) : rawTitle;
            const body = {
                newTitle: title,
                text: payload.code,
                slug: fullSlug,
                language: payload.language || 'python',
                kernelType: payload.kernelType || 'script',
                isPrivate: payload.isPrivate !== false,
                enableGpu: !!payload.enableGpu,
                enableInternet: payload.enableInternet !== false,
                datasetDataSources: payload.datasetDataSources || [],
                competitionDataSources: payload.competitionDataSources || [],
                kernelDataSources: payload.kernelDataSources || []
            };
            if (payload.machineShape)
                body.machineShape = payload.machineShape;
            if (payload.modelDataSources && payload.modelDataSources.length > 0)
                body.modelDataSources = payload.modelDataSources;
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
            const resData = await res.json();
            if (resData.hasError || resData.error) {
                return {
                    success: false,
                    kernelUrl: '',
                    error: `KAGGLE_PUSH_FAILED: ${resData.error || resData.errorNullable || 'Unknown push error'}`
                };
            }
            let actualSlug = rawSlug;
            if (resData.ref) {
                const parts = resData.ref.replace(/^\/code\//, '').split('/');
                if (parts.length > 1)
                    actualSlug = parts[1];
            }
            else if (resData.url) {
                const parts = resData.url.replace(/^https:\/\/www\.kaggle\.com\/code\//, '').split('/');
                if (parts.length > 1)
                    actualSlug = parts[1];
            }
            const versionNumber = typeof resData.versionNumber === 'number'
                ? resData.versionNumber
                : typeof resData.version_number === 'number'
                    ? resData.version_number
                    : typeof resData.version === 'number'
                        ? resData.version
                        : undefined;
            return {
                success: true,
                kernelUrl: resData.url || `https://www.kaggle.com/code/${this.username}/${actualSlug}`,
                kernelSlug: actualSlug,
                versionNumber
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
            const rawSlug = kernelSlug.includes('/') ? kernelSlug.split('/')[1] : kernelSlug;
            const url = `${this.baseUrl}/kernels/status?userName=${encodeURIComponent(this.username)}&kernelSlug=${encodeURIComponent(rawSlug)}`;
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
    async downloadKernelOutput(kernelSlug, targetDirOrR2Bucket) {
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
                ],
                log: 'Mock Kaggle output stdout: Execution success\nLoss: 0.042'
            };
        }
        try {
            const owner = kernelSlug.includes('/') ? kernelSlug.split('/')[0] : (typeof targetDirOrR2Bucket === 'string' && targetDirOrR2Bucket ? targetDirOrR2Bucket : this.username);
            const rawSlug = kernelSlug.includes('/') ? kernelSlug.split('/')[1] : kernelSlug;
            const url = `${this.baseUrl}/kernels/output?userName=${encodeURIComponent(owner)}&kernelSlug=${encodeURIComponent(rawSlug)}`;
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
                let logText = typeof data.log === 'string' ? data.log : '';
                try {
                    const parsedLog = typeof data.log === 'string' ? JSON.parse(data.log) : data.log;
                    if (Array.isArray(parsedLog)) {
                        logText = parsedLog.map((item) => item.data || '').join('');
                    }
                }
                catch { }
                files.push({
                    name: 'stdout.log',
                    content: logText,
                    sizeBytes: Buffer.byteLength(logText)
                });
            }
            if (Array.isArray(data.files)) {
                for (const file of data.files) {
                    let content = file.content;
                    if (!content && file.url) {
                        try {
                            const fileRes = await fetch(file.url);
                            if (fileRes.ok) {
                                content = await fileRes.text();
                            }
                        }
                        catch (err) {
                            console.error(`Failed to fetch file content from ${file.url}:`, err);
                        }
                    }
                    files.push({
                        name: file.fileName || file.name || 'output_file',
                        content: content || '',
                        sizeBytes: content ? Buffer.byteLength(content) : (file.size || 0)
                    });
                }
            }
            return { success: true, files, log: typeof data.log === 'string' ? data.log : undefined };
        }
        catch (err) {
            return { success: false, files: [], error: err.message };
        }
    }
    /**
     * Lists/searches Kaggle projects.
     */
    async listProjects(params = {}) {
        if (this.isMockMode) {
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
        try {
            const queryParams = new URLSearchParams();
            const targetUser = (params.mine !== false || params.user) ? (params.user || this.username) : undefined;
            if (targetUser)
                queryParams.set('user', targetUser);
            if (params.search)
                queryParams.set('search', params.search);
            if (params.kernelType && params.kernelType !== 'all')
                queryParams.set('kernelType', params.kernelType);
            if (params.language)
                queryParams.set('language', params.language);
            if (params.sortBy)
                queryParams.set('sortBy', params.sortBy);
            const pageSize = Math.min(params.pageSize || 20, 50);
            queryParams.set('pageSize', String(pageSize));
            if (params.pageToken)
                queryParams.set('page', params.pageToken);
            const url = `${this.baseUrl}/kernels/list?${queryParams.toString()}`;
            const res = await fetch(url, {
                headers: { 'Authorization': this.getAuthHeader() }
            });
            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`KAGGLE_LIST_FAILED: HTTP ${res.status}: ${errText}`);
            }
            const list = await res.json();
            if (!Array.isArray(list))
                return [];
            return list.map(item => {
                const ref = item.ref || `${item.author || this.username}/${item.slug || 'kernel'}`;
                const parts = ref.split('/');
                const owner = parts[0] || item.author || this.username;
                const slug = parts.slice(1).join('/') || item.slug || '';
                return {
                    ref,
                    slug,
                    owner,
                    title: item.title || slug,
                    kernelType: item.kernelType || (item.hasKernelType ? item.kernelType : 'script'),
                    language: item.language || 'python',
                    lastRunTime: item.lastRunTime,
                    isPrivate: item.isPrivate ?? (item.hasIsPrivate ? item.isPrivate : undefined)
                };
            });
        }
        catch (err) {
            throw new Error(`KAGGLE_PROJECT_LIST_ERROR: ${err.message}`);
        }
    }
    /**
     * Pulls current or known version source and metadata.
     */
    async pullProject(owner, slug, version) {
        if (this.isMockMode) {
            if (version === 999) {
                throw new Error('KAGGLE_VERSION_NOT_FOUND: Version 999 not found');
            }
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
                currentVersionNumber: version || 1,
                machineShape: isNotebook ? 'NvidiaTeslaT4' : undefined,
                datasetDataSources: isNotebook ? ['astorhsu/astor-gate2c-8g-kaggle-package'] : [],
                competitionDataSources: [],
                kernelDataSources: [],
                modelDataSources: []
            };
            return { metadata: mockMetadata, source: mockSource };
        }
        try {
            const slugWithVersion = (version !== undefined && version !== null) ? `${slug}/${version}` : slug;
            const url = `${this.baseUrl}/kernels/pull?userName=${encodeURIComponent(owner)}&kernelSlug=${encodeURIComponent(slugWithVersion)}`;
            const res = await fetch(url, {
                headers: { 'Authorization': this.getAuthHeader() }
            });
            if (!res.ok) {
                const errText = await res.text();
                if (version !== undefined && version !== null) {
                    if (res.status === 403 || res.status === 404) {
                        const structured = JSON.stringify({
                            error: 'KAGGLE_VERSION_ACCESS_DENIED_OR_NOT_FOUND',
                            kernelRef: `${owner}/${slug}`,
                            requestedVersion: version,
                            currentProjectPullSucceeded: true,
                            httpStatus: res.status,
                            rawMessage: errText,
                            authMode: 'kaggle_basic',
                            message: `HTTP ${res.status}: Historical version ${version} for kernel ${owner}/${slug} access denied or not found.`
                        });
                        throw new Error(structured);
                    }
                    throw new Error(`KAGGLE_VERSION_PULL_FAILED: HTTP ${res.status}: Failed to pull version ${version} for kernel ${owner}/${slug}: ${errText}`);
                }
                throw new Error(`KAGGLE_PULL_FAILED: HTTP ${res.status}: ${errText}`);
            }
            const data = await res.json();
            if (!data || typeof data !== 'object') {
                throw new Error('KAGGLE_PROJECT_RESPONSE_UNRECOGNIZED: Response body is not a valid JSON object');
            }
            const metadata = data.metadata;
            const blob = data.blob;
            if (!metadata && !blob && typeof data.source !== 'string') {
                throw new Error(`KAGGLE_PROJECT_RESPONSE_UNRECOGNIZED: Response missing both metadata and blob. Keys: ${Object.keys(data).join(',')}`);
            }
            const source = typeof blob?.source === 'string'
                ? blob.source
                : (typeof data.source === 'string' ? data.source : undefined);
            if (source === undefined) {
                throw new Error(`KAGGLE_PROJECT_SOURCE_MISSING: Source code blob not found in Kaggle response. Blob keys: ${blob ? Object.keys(blob).join(',') : 'none'}`);
            }
            return { metadata: metadata || {}, source };
        }
        catch (err) {
            if (err.message?.startsWith('KAGGLE_'))
                throw err;
            throw new Error(`KAGGLE_PROJECT_PULL_ERROR: ${err.message}`);
        }
    }
    /**
     * Retrieves output files metadata for a project.
     */
    async getProjectOutputFiles(owner, slug) {
        if (this.isMockMode) {
            return {
                files: [
                    { name: 'stdout.log', size: 1024, creationTime: new Date().toISOString() },
                    { name: 'metrics.json', size: 128, creationTime: new Date().toISOString() }
                ],
                log: 'Mock log line 1\nMock log line 2'
            };
        }
        try {
            const url = `${this.baseUrl}/kernels/output?userName=${encodeURIComponent(owner)}&kernelSlug=${encodeURIComponent(slug)}`;
            const res = await fetch(url, {
                headers: { 'Authorization': this.getAuthHeader() }
            });
            if (res.status === 404) {
                return { files: [] };
            }
            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`KAGGLE_OUTPUT_FAILED: HTTP ${res.status}: ${errText}`);
            }
            const data = await res.json();
            const files = [];
            if (Array.isArray(data.files)) {
                for (const f of data.files) {
                    files.push({
                        name: f.fileName || f.name || 'output',
                        size: f.size || 0,
                        url: f.url
                    });
                }
            }
            return { files, log: typeof data.log === 'string' ? data.log : undefined };
        }
        catch (err) {
            throw new Error(`KAGGLE_PROJECT_FILES_ERROR: ${err.message}`);
        }
    }
    /**
     * Retrieves project execution logs.
     */
    async getProjectLogs(owner, slug) {
        if (this.isMockMode) {
            return { logs: ['Mock log: execution complete', 'Memory: 1.2GB'], available: true };
        }
        try {
            const url = `${this.baseUrl}/kernels/output?userName=${encodeURIComponent(owner)}&kernelSlug=${encodeURIComponent(slug)}`;
            const res = await fetch(url, {
                headers: { 'Authorization': this.getAuthHeader() }
            });
            if (res.status === 404 || !res.ok) {
                return { logs: [], available: false };
            }
            const data = await res.json();
            let logText = typeof data.log === 'string' ? data.log : '';
            if (!logText && Array.isArray(data.log)) {
                logText = data.log.map((item) => item.data || '').join('');
            }
            if (!logText) {
                return { logs: [], available: false };
            }
            const logs = logText.split('\n').filter((l) => l.trim().length > 0);
            return { logs, available: true };
        }
        catch {
            return { logs: [], available: false };
        }
    }
    /**
     * Downloads a single selected output file safely with pre-check on size.
     */
    async downloadSingleOutputFile(owner, slug, fileName) {
        if (this.isMockMode) {
            const mockFiles = {
                'stdout.log': { name: 'stdout.log', content: 'Mock output stdout: Execution success\nLoss: 0.042', sizeBytes: 52 },
                'metrics.json': { name: 'metrics.json', content: JSON.stringify({ accuracy: 0.985, val_loss: 0.042 }, null, 2), sizeBytes: 46 }
            };
            const requested = fileName || 'stdout.log';
            const selected = mockFiles[requested] || Object.values(mockFiles)[0];
            return {
                file: selected,
                totalFiles: Object.keys(mockFiles).length,
                allFileNames: Object.keys(mockFiles),
                log: 'Mock output stdout: Execution success\nLoss: 0.042'
            };
        }
        try {
            const url = `${this.baseUrl}/kernels/output?userName=${encodeURIComponent(owner)}&kernelSlug=${encodeURIComponent(slug)}`;
            const res = await fetch(url, {
                headers: { 'Authorization': this.getAuthHeader() }
            });
            if (res.status === 404) {
                return { totalFiles: 0, allFileNames: [] };
            }
            if (!res.ok) {
                const errText = await res.text();
                return { totalFiles: 0, allFileNames: [], error: `Failed to fetch output: HTTP ${res.status}: ${errText}` };
            }
            const data = await res.json();
            const availableFiles = Array.isArray(data.files) ? data.files : [];
            const allFileNames = availableFiles.map((f) => f.fileName || f.name || 'output_file');
            if (data.log && !allFileNames.includes('stdout.log')) {
                allFileNames.unshift('stdout.log');
            }
            if (!allFileNames.length) {
                return { totalFiles: 0, allFileNames: [] };
            }
            // Match requested file or default to stdout.log / first file
            let matchedFile;
            if (fileName) {
                matchedFile = availableFiles.find((f) => (f.fileName || f.name || '').toLowerCase() === fileName.toLowerCase());
            }
            if (!matchedFile && (!fileName || fileName.toLowerCase() === 'stdout.log')) {
                if (data.log) {
                    let logText = typeof data.log === 'string' ? data.log : '';
                    try {
                        const parsedLog = typeof data.log === 'string' ? JSON.parse(data.log) : data.log;
                        if (Array.isArray(parsedLog))
                            logText = parsedLog.map((item) => item.data || '').join('');
                    }
                    catch { }
                    return {
                        file: {
                            name: 'stdout.log',
                            content: logText,
                            sizeBytes: Buffer.byteLength(logText)
                        },
                        totalFiles: allFileNames.length,
                        allFileNames,
                        log: logText
                    };
                }
            }
            if (!matchedFile) {
                matchedFile = availableFiles[0];
            }
            if (!matchedFile) {
                return { totalFiles: allFileNames.length, allFileNames };
            }
            const targetName = matchedFile.fileName || matchedFile.name || 'output_file';
            const targetSize = matchedFile.size || matchedFile.sizeBytes || 0;
            // Pre-rejection check: > 20 MiB (20971520 bytes)
            if (targetSize > 20971520) {
                throw new Error(`KAGGLE_OUTPUT_TOO_LARGE: Output file "${targetName}" (${targetSize} bytes) exceeds the 20 MiB R2 single-object limit`);
            }
            let content = matchedFile.content;
            if (!content && matchedFile.url) {
                const fileRes = await fetch(matchedFile.url);
                if (!fileRes.ok) {
                    throw new Error(`Failed to fetch file content from ${matchedFile.url}: HTTP ${fileRes.status}`);
                }
                const arrayBuf = await fileRes.arrayBuffer();
                if (arrayBuf.byteLength > 20971520) {
                    throw new Error(`KAGGLE_OUTPUT_TOO_LARGE: Output file "${targetName}" (${arrayBuf.byteLength} bytes) exceeds the 20 MiB R2 single-object limit`);
                }
                content = Buffer.from(arrayBuf);
            }
            const finalSize = content ? (typeof content === 'string' ? Buffer.byteLength(content) : content.length) : targetSize;
            return {
                file: {
                    name: targetName,
                    content,
                    sizeBytes: finalSize,
                    url: matchedFile.url
                },
                totalFiles: allFileNames.length,
                allFileNames,
                log: typeof data.log === 'string' ? data.log : undefined
            };
        }
        catch (err) {
            if (err.message?.includes('KAGGLE_OUTPUT_TOO_LARGE')) {
                throw err;
            }
            return { totalFiles: 0, allFileNames: [], error: err.message };
        }
    }
    mockBlobs = new Map();
    mockDatasets = new Map();
    /**
     * Registers a mock dataset for unit and integration testing.
     */
    registerMockDataset(owner, slug, version, files, metadata) {
        const key = `${owner}/${slug}`;
        const filesMap = new Map();
        if (files instanceof Map) {
            for (const [k, v] of files.entries()) {
                filesMap.set(k, Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf-8'));
            }
        }
        else {
            for (const [k, v] of Object.entries(files)) {
                filesMap.set(k, Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf-8'));
            }
        }
        let ds = this.mockDatasets.get(key);
        if (!ds) {
            ds = {
                metadata: {
                    ref: key,
                    title: slug,
                    currentVersionNumber: version,
                    isPrivate: true,
                    totalBytes: 0,
                    ...metadata
                },
                currentVersion: version,
                versions: new Map()
            };
            this.mockDatasets.set(key, ds);
        }
        ds.currentVersion = Math.max(ds.currentVersion, version);
        ds.metadata.currentVersionNumber = ds.currentVersion;
        ds.versions.set(version, { files: filesMap });
    }
    /**
     * Retrieves dataset metadata.
     */
    async getDataset(owner, slug) {
        if (this.isMockMode) {
            const key = `${owner}/${slug}`;
            const mockDs = this.mockDatasets.get(key);
            if (mockDs) {
                return mockDs.metadata;
            }
            return {
                ref: key,
                title: slug,
                currentVersionNumber: 1,
                isPrivate: true,
                totalBytes: 1024
            };
        }
        const url = `${this.baseUrl}/datasets.DatasetApiService/GetDataset`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': this.getAuthHeader(),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ ownerSlug: owner, datasetSlug: slug })
        });
        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`KAGGLE_GET_DATASET_FAILED: HTTP ${res.status}: Failed to get dataset ${owner}/${slug}: ${errText}`);
        }
        const data = await res.json();
        const currentVersionNumber = typeof data.currentVersionNumber === 'number'
            ? data.currentVersionNumber
            : (Array.isArray(data.versions) && data.versions.length > 0 ? (data.versions[data.versions.length - 1].versionNumber || 1) : 1);
        return {
            id: data.id,
            ref: data.ref || `${owner}/${slug}`,
            title: data.title || slug,
            currentVersionNumber,
            totalBytes: data.totalBytes,
            isPrivate: data.isPrivate,
            licenseName: data.licenseName,
            description: data.description
        };
    }
    /**
     * Lists files contained in a specific dataset version.
     * Auto-paginates all pages when pageToken is omitted up to safety limit of 50 pages.
     */
    async listDatasetFiles(owner, slug, version, pageSize = 100, pageToken) {
        if (this.isMockMode) {
            const key = `${owner}/${slug}`;
            const mockDs = this.mockDatasets.get(key);
            if (mockDs) {
                const verNum = version || mockDs.currentVersion;
                const verData = mockDs.versions.get(verNum);
                if (verData) {
                    const files = [];
                    for (const [name, buf] of verData.files.entries()) {
                        files.push({ name, totalBytes: buf.length });
                    }
                    if (pageToken) {
                        const offset = parseInt(pageToken, 10) || 0;
                        const slice = files.slice(offset, offset + pageSize);
                        const nextTok = (offset + pageSize < files.length) ? String(offset + pageSize) : undefined;
                        return { datasetFiles: slice, nextPageToken: nextTok };
                    }
                    return { datasetFiles: files };
                }
            }
            return {
                datasetFiles: [
                    { name: 'devspace-project.json', totalBytes: 1024 },
                    { name: 'PROJECT_CONTEXT.md', totalBytes: 4096 }
                ]
            };
        }
        if (pageToken) {
            return this.fetchSingleDatasetFilesPage(owner, slug, version, pageSize, pageToken);
        }
        // Auto-paginate through all pages up to hard safety limit (50 pages / 5,000 files)
        const allFiles = [];
        let curToken = undefined;
        let pageCount = 0;
        const MAX_PAGES = 50;
        do {
            const pageResult = await this.fetchSingleDatasetFilesPage(owner, slug, version, pageSize, curToken);
            allFiles.push(...pageResult.datasetFiles);
            curToken = pageResult.nextPageToken;
            pageCount++;
        } while (curToken && pageCount < MAX_PAGES);
        return {
            datasetFiles: allFiles
        };
    }
    async fetchSingleDatasetFilesPage(owner, slug, version, pageSize = 100, pageToken) {
        const url = `${this.baseUrl}/datasets.DatasetApiService/ListDatasetFiles`;
        const reqBody = {
            ownerSlug: owner,
            datasetSlug: slug,
            pageSize
        };
        if (version !== undefined && version !== null) {
            reqBody.datasetVersionNumber = version;
        }
        if (pageToken) {
            reqBody.pageToken = pageToken;
        }
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': this.getAuthHeader(),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(reqBody)
        });
        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`KAGGLE_LIST_DATASET_FILES_FAILED: HTTP ${res.status}: ${errText}`);
        }
        const data = await res.json();
        const datasetFiles = (data.datasetFiles || []).map((f) => ({
            name: f.name,
            totalBytes: typeof f.totalBytes === 'number' ? f.totalBytes : 0
        }));
        return {
            datasetFiles,
            nextPageToken: data.nextPageToken
        };
    }
    /**
     * Downloads a specific file from a specific dataset version.
     */
    async downloadDatasetFile(owner, slug, fileName, version) {
        if (this.isMockMode) {
            const key = `${owner}/${slug}`;
            const mockDs = this.mockDatasets.get(key);
            if (mockDs) {
                const verNum = version || mockDs.currentVersion;
                const verData = mockDs.versions.get(verNum);
                if (verData) {
                    const buf = verData.files.get(fileName);
                    if (buf) {
                        return { content: buf, sizeBytes: buf.length };
                    }
                }
            }
            if (fileName === 'devspace-project.json') {
                const mockManifest = JSON.stringify({
                    name: slug,
                    slug,
                    owner,
                    version: version || 1,
                    type: 'workspace',
                    entrypoint: 'experiments/gate2c_9a_mining.py',
                    runnerKernelRef: `${owner}/${slug}-runner`,
                    files: {
                        'devspace-project.json': { size: 100, sha256: 'mock-sha-manifest' },
                        'PROJECT_CONTEXT.md': { size: 200, sha256: 'mock-sha-context' }
                    }
                }, null, 2);
                const b = Buffer.from(mockManifest, 'utf-8');
                return { content: b, sizeBytes: b.length };
            }
            const defContent = Buffer.from(`# Mock content for ${fileName}\n`, 'utf-8');
            return { content: defContent, sizeBytes: defContent.length };
        }
        const queryParams = new URLSearchParams();
        queryParams.set('fileName', fileName);
        if (version !== undefined && version !== null) {
            queryParams.set('datasetVersionNumber', String(version));
        }
        const url = `${this.baseUrl}/datasets/download/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}?${queryParams.toString()}`;
        const res = await fetch(url, {
            headers: { 'Authorization': this.getAuthHeader() }
        });
        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`KAGGLE_DOWNLOAD_FILE_FAILED: HTTP ${res.status}: Failed to download "${fileName}" from ${owner}/${slug}: ${errText}`);
        }
        const arrayBuf = await res.arrayBuffer();
        const content = Buffer.from(arrayBuf);
        return {
            content,
            sizeBytes: content.length
        };
    }
    /**
     * Uploads a file blob to Kaggle GCS storage and returns a blob token.
     */
    async uploadBlob(fileName, content) {
        const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8');
        if (this.isMockMode) {
            const token = `mock-blob-token-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            this.mockBlobs.set(token, { fileName, content: buf });
            return token;
        }
        const nowUtc = Math.floor(Date.now() / 1000);
        const startReq = {
            type: 1, // ApiBlobType.DATASET = 1
            name: fileName,
            contentLength: buf.length,
            lastModifiedEpochSeconds: nowUtc
        };
        const startUrl = `${this.baseUrl}/blobs.BlobApiService/StartBlobUpload`;
        const startRes = await fetch(startUrl, {
            method: 'POST',
            headers: {
                'Authorization': this.getAuthHeader(),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(startReq)
        });
        if (!startRes.ok) {
            const errText = await startRes.text();
            throw new Error(`KAGGLE_BLOB_UPLOAD_FAILED: HTTP ${startRes.status}: ${errText}`);
        }
        const startData = await startRes.json();
        const { token, createUrl } = startData;
        if (!createUrl || !token) {
            throw new Error('KAGGLE_BLOB_UPLOAD_FAILED: No createUrl or token returned from StartBlobUpload');
        }
        const gcsRes = await fetch(createUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: buf
        });
        if (!gcsRes.ok) {
            const gcsErrText = await gcsRes.text();
            throw new Error(`KAGGLE_GCS_UPLOAD_FAILED: HTTP ${gcsRes.status}: ${gcsErrText}`);
        }
        return token;
    }
    /**
     * Creates a new Kaggle Dataset.
     */
    async createDataset(slug, title, files, directories, isPrivate = true) {
        if (this.isMockMode) {
            const owner = this.getUsername();
            const filesMap = new Map();
            for (const f of files) {
                const blob = this.mockBlobs.get(f.token);
                if (blob) {
                    filesMap.set(f.description || blob.fileName, blob.content);
                }
            }
            const extractDirs = (dirs, prefix = '') => {
                for (const d of dirs || []) {
                    const dirPrefix = prefix ? `${prefix}/${d.name}` : d.name;
                    for (const f of d.files || []) {
                        const blob = this.mockBlobs.get(f.token);
                        if (blob)
                            filesMap.set(`${dirPrefix}/${f.description || blob.fileName}`, blob.content);
                    }
                    extractDirs(d.directories, dirPrefix);
                }
            };
            extractDirs(directories || []);
            this.registerMockDataset(owner, slug, 1, filesMap, { title, isPrivate });
            return {
                success: true,
                url: `https://www.kaggle.com/datasets/${owner}/${slug}`,
                ref: `${owner}/${slug}`
            };
        }
        const createUrl = `${this.baseUrl}/datasets.DatasetApiService/CreateDataset`;
        const createReq = {
            title,
            slug,
            ownerSlug: this.getUsername(),
            licenseName: 'CC0-1.0',
            isPrivate,
            files
        };
        if (directories && directories.length > 0) {
            createReq.directories = directories;
        }
        const res = await fetch(createUrl, {
            method: 'POST',
            headers: {
                'Authorization': this.getAuthHeader(),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(createReq)
        });
        if (!res.ok) {
            const errText = await res.text();
            return { success: false, error: `HTTP ${res.status}: ${errText}` };
        }
        const data = await res.json();
        if (data.status && data.status !== 'Ok' && data.error) {
            return { success: false, error: data.error };
        }
        return {
            success: true,
            url: data.url || `https://www.kaggle.com/datasets/${this.getUsername()}/${slug}`,
            ref: data.ref || `${this.getUsername()}/${slug}`
        };
    }
    /**
     * Creates a new version of an existing Kaggle Dataset.
     */
    async createDatasetVersion(slug, versionNotes, files, directories) {
        if (this.isMockMode) {
            const owner = this.getUsername();
            const key = `${owner}/${slug}`;
            const mockDs = this.mockDatasets.get(key);
            const nextVer = (mockDs?.currentVersion || 1) + 1;
            const filesMap = new Map();
            for (const f of files) {
                const blob = this.mockBlobs.get(f.token);
                if (blob) {
                    filesMap.set(f.description || blob.fileName, blob.content);
                }
            }
            const extractDirs = (dirs, prefix = '') => {
                for (const d of dirs || []) {
                    const dirPrefix = prefix ? `${prefix}/${d.name}` : d.name;
                    for (const f of d.files || []) {
                        const blob = this.mockBlobs.get(f.token);
                        if (blob)
                            filesMap.set(`${dirPrefix}/${f.description || blob.fileName}`, blob.content);
                    }
                    extractDirs(d.directories, dirPrefix);
                }
            };
            extractDirs(directories || []);
            this.registerMockDataset(owner, slug, nextVer, filesMap);
            return {
                success: true,
                url: `https://www.kaggle.com/datasets/${owner}/${slug}`,
                ref: `${owner}/${slug}`
            };
        }
        const verUrl = `${this.baseUrl}/datasets.DatasetApiService/CreateDatasetVersion`;
        const verBody = {
            versionNotes,
            files
        };
        if (directories && directories.length > 0) {
            verBody.directories = directories;
        }
        const verReq = {
            ownerSlug: this.getUsername(),
            datasetSlug: slug,
            body: verBody
        };
        const res = await fetch(verUrl, {
            method: 'POST',
            headers: {
                'Authorization': this.getAuthHeader(),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(verReq)
        });
        if (!res.ok) {
            const errText = await res.text();
            return { success: false, error: `HTTP ${res.status}: ${errText}` };
        }
        const data = await res.json();
        if (data.status && data.status !== 'Ok' && data.error) {
            return { success: false, error: data.error };
        }
        return {
            success: true,
            url: data.url || `https://www.kaggle.com/datasets/${this.getUsername()}/${slug}`,
            ref: data.ref || `${this.getUsername()}/${slug}`
        };
    }
    /**
     * Gets dataset status.
     */
    async getDatasetStatus(slug, owner) {
        if (this.isMockMode) {
            return { status: 'READY', isReady: true };
        }
        const effectiveOwner = owner || this.getUsername();
        const statUrl = `${this.baseUrl}/datasets.DatasetApiService/GetDatasetStatus`;
        const res = await fetch(statUrl, {
            method: 'POST',
            headers: {
                'Authorization': this.getAuthHeader(),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ ownerSlug: effectiveOwner, datasetSlug: slug })
        });
        if (!res.ok) {
            const errText = await res.text();
            return { status: `HTTP ${res.status}: ${errText}`, isReady: false };
        }
        const data = await res.json();
        const rawStatus = (data.status || '').toUpperCase();
        return {
            status: rawStatus,
            isReady: rawStatus === 'READY' || rawStatus === 'OK'
        };
    }
}
exports.CloudflareKaggleHttpClient = CloudflareKaggleHttpClient;
