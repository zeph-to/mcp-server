export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    status: number;
  };
}

export interface PushResponse {
  data: {
    pushId: string;
  };
}

export interface HookTriggerResponse {
  data: {
    pushId: string;
    eventId: string;
  };
}

export interface HookEventResponse {
  data: {
    eventId: string;
    status: 'pending' | 'responded' | 'timed_out' | 'cancelled';
    response?: {
      actionId?: string;
      value?: string;
      /** Screenshots and files the user attached to the answer — plaintext,
       *  since the hook route carries no key this end could decrypt with. */
      files?: AttachedFile[];
      respondedDeviceId?: string;
    };
  };
}

export interface DeviceRecord {
  deviceId: string;
  nickname?: string;
  type?: string;
  model?: string;
  isOnline?: boolean;
  lastSeenAt?: string;
  publicKey?: string;
}

export interface DevicesResponse {
  data: DeviceRecord[];
}

export interface AgentSessionRenameResponse {
  data: DeviceRecord;
}

export interface PushRecord {
  pushId: string;
  type: string;
  title?: string;
  body?: string;
  url?: string;
  priority?: string;
  senderDeviceId?: string;
  targetDeviceId?: string;
  channelId?: string;
  fileKey?: string;
  fileName?: string;
  fileSize?: number;
  createdAt: string;
}

export interface PushListResponse {
  data: PushRecord[];
  pagination: {
    cursor?: string;
    hasMore: boolean;
  };
}

export interface DismissResponse {
  data: {
    dismissed: boolean | number;
    badge?: number;
  };
}

export interface ChannelRecord {
  channelId: string;
  tag: string;
  name: string;
  description?: string;
  ownerId: string;
  subscriberCount: number;
  isPublic: boolean;
}

export interface ChannelsResponse {
  data: ChannelRecord[];
}

export interface UploadRequestResponse {
  data: {
    fileId: string;
    fileKey: string;
    uploadUrl: string;
  };
}

export interface DownloadUrlResponse {
  data: {
    downloadUrl: string;
  };
}

export interface AttachedFile {
  fileKey: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  iv?: string;
  /**
   * E2E: the file AES key wrapped once per recipient device, keyed by
   * `deviceId`. Each value is a JSON string `{ encryptedKey, keyIv }`.
   * (The superseded account-wide `encryptedKey` field is not written here —
   * nothing can unwrap it since key escrow was removed.)
   */
  deviceKeyMap?: Record<string, string>;
}

export interface ToolError {
  error: string;
  message: string;
  retryAfter?: number;
  suggestion?: string;
}
