import { Server } from '@modelcontextprotocol/sdk/server/index';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types';
import { GatewayServer } from '../gateway/server';
import { McpHandlers } from './handlers';
import * as tools from './tools';

export class DevSpaceMcpServer {
  private server: Server;
  private gateway: GatewayServer;
  private handlers: McpHandlers;

  constructor(gateway?: GatewayServer) {
    this.gateway = gateway || new GatewayServer({ storageDir: '.devspace-storage' });
    this.handlers = new McpHandlers(this.gateway);

    this.server = new Server(
      {
        name: 'devspace-ultra',
        version: '2.0.0'
      },
      {
        capabilities: {
          tools: {}
        }
      }
    );

    this.setupHandlers();
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'remote_task_submit',
            description: 'Submit a durable task to execute across backends (kaggle, local Windows agent, swarm, browser)',
            inputSchema: tools.REMOTE_TASK_SUBMIT_SCHEMA
          },
          {
            name: 'remote_task_status',
            description: 'Query status, lifecycle state, execution result, and error of a durable task by taskId',
            inputSchema: tools.REMOTE_TASK_STATUS_SCHEMA
          },
          {
            name: 'remote_task_logs',
            description: 'Fetch real-time streaming execution logs for a task',
            inputSchema: tools.REMOTE_TASK_LOGS_SCHEMA
          },
          {
            name: 'remote_task_artifacts',
            description: 'List generated output artifacts, files, and previews for a task',
            inputSchema: tools.REMOTE_TASK_ARTIFACTS_SCHEMA
          },
          {
            name: 'remote_task_cancel',
            description: 'Cancel an active or queued task',
            inputSchema: tools.REMOTE_TASK_CANCEL_SCHEMA
          },
          {
            name: 'kaggle_run',
            description: 'Run Python script or Jupyter Notebook on remote Free Kaggle GPU backend (asynchronous and durable)',
            inputSchema: tools.KAGGLE_RUN_SCHEMA
          },
          {
            name: 'kaggle_status',
            description: 'Check status of a Kaggle GPU execution job',
            inputSchema: tools.KAGGLE_STATUS_SCHEMA
          },
          {
            name: 'kaggle_logs',
            description: 'Fetch stdout/stderr logs from a running or completed Kaggle job',
            inputSchema: tools.KAGGLE_LOGS_SCHEMA
          },
          {
            name: 'kaggle_result',
            description: 'Retrieve final metrics, output files, and artifacts from a completed Kaggle job',
            inputSchema: tools.KAGGLE_RESULT_SCHEMA
          },
          {
            name: 'swarm_dispatch',
            description: 'Dispatch a prompt instruction task to Chat Swarm worker with automated claim and ack',
            inputSchema: tools.SWARM_DISPATCH_SCHEMA
          },
          {
            name: 'swarm_status',
            description: 'List active Chat Swarm workers, current task allocations, and wake bridge status',
            inputSchema: tools.SWARM_STATUS_SCHEMA
          },
          {
            name: 'device_status',
            description: 'List registered local outbound agent devices and their online/offline status',
            inputSchema: tools.DEVICE_STATUS_SCHEMA
          },
          {
            name: 'kill_switch_trigger',
            description: 'Trigger emergency stop or revoke rogue client/device access immediately',
            inputSchema: tools.KILL_SWITCH_TRIGGER_SCHEMA
          }
        ]
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        let result: any;
        switch (name) {
          case 'remote_task_submit':
            result = await this.handlers.handleRemoteTaskSubmit(args);
            break;
          case 'remote_task_status':
            result = await this.handlers.handleRemoteTaskStatus(args);
            break;
          case 'remote_task_logs':
            result = await this.handlers.handleRemoteTaskLogs(args);
            break;
          case 'remote_task_artifacts':
            result = await this.handlers.handleRemoteTaskArtifacts(args);
            break;
          case 'remote_task_cancel':
            result = await this.handlers.handleRemoteTaskCancel(args);
            break;
          case 'kaggle_run':
            result = await this.handlers.handleKaggleRun(args);
            break;
          case 'kaggle_status':
            result = await this.handlers.handleKaggleStatus(args);
            break;
          case 'kaggle_logs':
            result = await this.handlers.handleKaggleLogs(args);
            break;
          case 'kaggle_result':
            result = await this.handlers.handleKaggleResult(args);
            break;
          case 'swarm_dispatch':
            result = await this.handlers.handleSwarmDispatch(args);
            break;
          case 'swarm_status':
            result = await this.handlers.handleSwarmStatus();
            break;
          case 'device_status':
            result = await this.handlers.handleDeviceStatus();
            break;
          case 'kill_switch_trigger':
            result = await this.handlers.handleKillSwitchTrigger(args);
            break;
          default:
            throw new Error(`UNKNOWN_TOOL: Tool '${name}' is not recognized`);
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: err.code || 'TOOL_EXECUTION_ERROR',
                message: err.message || 'Error occurred while executing tool'
              }, null, 2)
            }
          ]
        };
      }
    });
  }

  public async startStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}

// If invoked directly from CLI
if (require.main === module) {
  const mcpServer = new DevSpaceMcpServer();
  mcpServer.startStdio().catch((err) => {
    console.error('Failed to start MCP server:', err);
    process.exit(1);
  });
}
