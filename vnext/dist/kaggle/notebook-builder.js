"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotebookBuilder = void 0;
class NotebookBuilder {
    /**
     * Builds kernel-metadata.json structure for Kaggle CLI.
     */
    static buildMetadata(username, payload) {
        const slug = payload.kernelSlug.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
        const codeFile = payload.kernelType === 'notebook' ? 'notebook.ipynb' : 'script.py';
        return {
            id: `${username}/${slug}`,
            title: payload.title || slug,
            code_file: codeFile,
            language: payload.language || 'python',
            kernel_type: payload.kernelType || 'script',
            is_private: payload.isPrivate !== false,
            enable_gpu: !!payload.enableGpu,
            enable_tpu: false,
            enable_internet: payload.enableInternet !== false,
            dataset_sources: payload.datasetDataSources || [],
            competition_sources: payload.competitionDataSources || [],
            kernel_sources: payload.kernelDataSources || []
        };
    }
    /**
     * Formats raw python code into a basic Jupyter Notebook structure if needed.
     */
    static codeToIpynb(pythonCode) {
        const notebook = {
            cells: [
                {
                    cell_type: 'code',
                    execution_count: null,
                    metadata: {},
                    outputs: [],
                    source: pythonCode.split('\n').map(line => line + '\n')
                }
            ],
            metadata: {
                kernelspec: {
                    display_name: 'Python 3',
                    language: 'python',
                    name: 'python3'
                },
                language_info: {
                    name: 'python',
                    version: '3.10.12'
                }
            },
            nbformat: 4,
            nbformat_minor: 2
        };
        return JSON.stringify(notebook, null, 2);
    }
}
exports.NotebookBuilder = NotebookBuilder;
