import { DurableTask, TaskStatus } from '../types/task';
import { ClientRecord, DeviceRecord } from '../types/auth';
import { ArtifactMetadata } from '../types/artifacts';
import { AuditEvent } from '../types/audit';

export interface IStorageAdapter {
  // Tasks
  getTask(taskId: string): Promise<DurableTask | undefined>;
  getTaskSync?(taskId: string): DurableTask | undefined;
  saveTask(task: DurableTask): Promise<void>;
  listTasks(filter?: { status?: TaskStatus; backend?: string; capability?: string; limit?: number }): Promise<DurableTask[]>;
  deleteTask(taskId: string): Promise<boolean>;

  // Idempotency
  getIdempotency(key: string): Promise<DurableTask | undefined>;
  setIdempotency(key: string, task: DurableTask, ttlMs?: number): Promise<void>;

  // Auth / Registry
  getClient(clientId: string): Promise<ClientRecord | undefined>;
  saveClient(client: ClientRecord): Promise<void>;
  listClients(): Promise<ClientRecord[]>;

  getDevice(deviceId: string): Promise<DeviceRecord | undefined>;
  saveDevice(device: DeviceRecord): Promise<void>;
  listDevices(): Promise<DeviceRecord[]>;

  isTokenRevoked(tokenId: string): Promise<boolean>;
  revokeToken(tokenId: string): Promise<void>;

  // Artifacts
  saveArtifactMetadata(meta: ArtifactMetadata): Promise<void>;
  getArtifactMetadata(id: string): Promise<ArtifactMetadata | undefined>;
  getArtifactMetadataSync?(id: string): ArtifactMetadata | undefined;
  listTaskArtifacts(taskId: string): Promise<ArtifactMetadata[]>;
  listTaskArtifactsSync?(taskId: string): ArtifactMetadata[];
  listArtifacts(): Promise<ArtifactMetadata[]>;

  // Audit
  appendAuditLog(event: AuditEvent): Promise<void>;
  getRecentAuditLogs(limit?: number): Promise<AuditEvent[]>;
}
