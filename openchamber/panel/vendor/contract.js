import { OPENCHAMBER_SDK_API_VERSION, OPENCHAMBER_SDK_CHANNEL } from './api-version.js';
export const START_SESSION_SENT = ['sent', 'no-model', 'skipped', 'failed'];
export const GUEST_BLOCK_ANSWER_MAX = 2_000;
export const SESSION_LIFECYCLE_PHASES = ['started', 'completed', 'failure'];
export const GUEST_FILE_ENTRY_KINDS = ['file', 'directory', 'other'];
export const GUEST_FILE_STAT_KINDS = ['file', 'directory', 'other', 'missing'];
export const isStartSessionResult = (value) => Boolean(value && 'sessionId' in value);
export const isPromptResult = (value) => Boolean(value && 'sent' in value && !('sessionId' in value));
export const EMPTY_GUEST_CONNECTION = {
    connected: false,
    account: '',
};
export const DEVICE_FORM_FACTORS = ['phone', 'tablet', 'desktop'];
export const DEVICE_POINTERS = ['coarse', 'fine'];
export const isGuestMessageItem = (item) => (item !== null && item.kind === 'message');
export const isGuestSessionItem = (item) => (item !== null && item.kind === 'session');
export const isGuestLinkItem = (item) => (item !== null && item.kind === 'link');
export const isGuestAttachItem = (item) => (item !== null && (item.kind === undefined || item.kind === 'issue' || item.kind === 'pull'));
export const GUEST_TOAST_MAX = 500;
export const GUEST_CLIPBOARD_TEXT_MAX = 32_000;
export const GUEST_COMPOSE_TEXT_MAX = 16_000;
export const GUEST_ATTACH_ID_MAX = 128;
export const GUEST_ATTACH_TITLE_MAX = 200;
export const GUEST_ATTACH_URL_MAX = 2_000;
export const GUEST_ATTACH_TEXT_MAX = 16_000;
export const GUEST_ATTACH_AUTHOR_MAX = 80;
export const GUEST_ATTACH_BRANCH_MAX = 200;
export const GUEST_ATTACH_DATA_MAX = 16_000;
export const GUEST_ACCOUNT_MAX = 200;
export const GUEST_SESSION_MODEL_MAX = 200;
export const GUEST_SESSION_AGENT_MAX = 80;
export const GUEST_SETTING_VALUE_MAX = 2_000;
export const GUEST_REQUEST_PATH_MAX = 2_000;
export const GUEST_REQUEST_BODY_MAX = 64_000;
export const GUEST_REQUEST_RESPONSE_MAX = 8_000_000;
export const GUEST_REQUEST_TIMEOUT_MS = 20_000;
export const GUEST_FILE_PATH_MAX = 1_024;
export const GUEST_FILE_CONTENT_MAX = 2_000_000;
export const GUEST_FILE_LIST_MAX = 2_000;
export const GUEST_GENERATE_PROMPT_MAX = 64_000;
export const GUEST_GENERATE_SYSTEM_MAX = 8_000;
export const GUEST_GENERATE_OUTPUT_TOKENS_MAX = 4_000;
export const GUEST_GENERATE_TEXT_MAX = 256_000;
export const GUEST_GENERATE_TIMEOUT_MS = 960_000;
export const GUEST_GENERATE_LATE_KEEP_MS = 60 * 60_000;
export const GUEST_GENERATE_LATE_MAX = 8;
export const GUEST_ITEM_MESSAGE_TEXT_MAX = 200_000;
export const GUEST_ITEM_SESSION_MAX = 2_000_000;
export const GUEST_BADGE_MAX = 999;
export const GUEST_FRAME_HEIGHT_MAX = 10_000;
export const GUEST_RESOLVE_ERROR_MAX = 500;
export const HOST_REQUEST_ERROR_CODES = [
    'HOST_UNAVAILABLE',
    'HOST_TIMEOUT',
    'HOST_REJECTED',
    'DISCONNECTED',
    'DISABLED',
    'BAD_PATH',
    'NO_INTEGRATION',
    'NO_SERVICE',
    'SERVICE_FAILED',
    'REQUEST_FAILED',
    'RESPONSE_TOO_LARGE',
    'NO_SESSION',
    'SESSION_BUSY',
    'NOT_GRANTED',
    'NO_DIRECTORY',
    'NOT_FOUND',
    'FILE_TOO_LARGE',
    'DENIED',
    'NO_MODEL',
    'MODEL_FAILED',
    'UNSUPPORTED',
];
export const SERVICE_STATUS_VALUES = ['stopped', 'starting', 'ready', 'failed'];
const hostRequestErrorCodeSet = new Set(HOST_REQUEST_ERROR_CODES);
export const isHostRequestErrorCode = (value) => (hostRequestErrorCodeSet.has(value));
export const resolveHostRequestErrorCode = (value) => (value && isHostRequestErrorCode(value) ? value : 'HOST_REJECTED');
export const isJsonValue = (value) => {
    if (value === undefined)
        return false;
    if (value === null || value === true || value === false)
        return true;
    if (String(value) === value)
        return true;
    if (Number(value) === value)
        return Number.isFinite(value);
    if (Array.isArray(value))
        return value.every(isJsonValue);
    if (Object(value) === value)
        return Object.values(value).every(isJsonValue);
    return false;
};
export const isAttachData = (value) => (isJsonValue(value) && JSON.stringify(value).length <= GUEST_ATTACH_DATA_MAX);
const clampBranch = (value) => (value?.trim().slice(0, GUEST_ATTACH_BRANCH_MAX) ?? '');
export const clampAttachRequest = (request) => {
    const id = request.id.trim().slice(0, GUEST_ATTACH_ID_MAX);
    const title = request.title.trim().slice(0, GUEST_ATTACH_TITLE_MAX);
    const url = request.url.trim().slice(0, GUEST_ATTACH_URL_MAX);
    const text = request.text?.trim().slice(0, GUEST_ATTACH_TEXT_MAX);
    const author = request.author?.trim().slice(0, GUEST_ATTACH_AUTHOR_MAX);
    const kind = request.kind === 'pull' ? 'pull' : 'issue';
    const next = {
        providerId: request.providerId.trim(),
        id,
        title: title || id,
        url,
        kind,
    };
    if (text) {
        next.text = text;
    }
    if (author) {
        next.author = author;
    }
    if (kind === 'pull') {
        const head = clampBranch(request.branches?.head);
        const base = clampBranch(request.branches?.base);
        if (head && base) {
            next.branches = { head, base };
        }
    }
    if (isAttachData(request.data)) {
        next.data = request.data;
    }
    return next;
};
export const clampStartSessionRequest = (request) => {
    const next = clampAttachRequest(request);
    if (request.projectId)
        next.projectId = request.projectId;
    if (request.navigation)
        next.navigation = request.navigation;
    if (request.worktree) {
        next.worktree = request.worktree;
    }
    return next;
};
export const clampPromptRequest = (request) => {
    const next = {
        text: request.text.trim().slice(0, GUEST_COMPOSE_TEXT_MAX),
    };
    if (request.send) {
        next.send = true;
    }
    return next;
};
export const clampBadgeCount = (count) => {
    if (count === null || !Number.isFinite(count))
        return null;
    return Math.min(GUEST_BADGE_MAX, Math.max(0, Math.round(count)));
};
export const clampFrameHeight = (height) => {
    if (!Number.isFinite(height))
        return 0;
    return Math.min(GUEST_FRAME_HEIGHT_MAX, Math.max(0, Math.ceil(height)));
};
export const guestFileScope = (path) => (path.startsWith('/') || path === '~' || path.startsWith('~/') ? 'filesystem' : 'project');
export const isGuestFilePath = (value) => (value.length > 0
    && value.length <= GUEST_FILE_PATH_MAX
    && !value.includes('\0')
    && !value.includes('\\'));
export const ATTACH_PROVIDER_ID = /^[a-z][a-z0-9-]*$/;
export const SETTING_KEY = /^[a-z][a-z0-9-]*$/;
export const isGuestRequestPath = (value) => {
    if (!value.startsWith('/') || value.includes('\0') || value.includes('\\') || value.includes('://')) {
        return false;
    }
    if (value.length > GUEST_REQUEST_PATH_MAX) {
        return false;
    }
    const segments = value.split('/');
    return !segments.some((segment) => segment === '.' || segment === '..');
};
const serviceStatusSet = new Set(SERVICE_STATUS_VALUES);
export const isServiceStatusResult = (value) => Boolean(value && 'status' in value && serviceStatusSet.has(String(value.status)) && !('body' in value));
export const isGuestRequestResult = (value) => Boolean(value && 'status' in value && 'body' in value && Number.isInteger(value.status));
export const isFileReadResult = (value) => Boolean(value && 'content' in value && String(value.content) === value.content);
export const isFileWriteResult = (value) => Boolean(value && 'written' in value && value.written === true);
export const isFileListResult = (value) => Boolean(value && 'entries' in value && Array.isArray(value.entries));
const fileStatKindSet = new Set(GUEST_FILE_STAT_KINDS);
export const isFileStatResult = (value) => Boolean(value && 'kind' in value && 'size' in value && fileStatKindSet.has(String(value.kind)) && Number.isFinite(value.size));
export const isGenerateResult = (value) => Boolean(value && 'text' in value && String(value.text) === value.text && !('status' in value));
const HOST_PUSH_TYPES = new Set([
    'workspace',
    'shells',
    'ready', 'directory', 'session', 'connection', 'settings', 'session-lifecycle', 'item', 'resolve', 'action', 'service-event',
    'status-control-event', 'popover-closed',
    'file-open', 'file-snapshot', 'file-saved',
    'generate-late',
    'microphone-audio', 'microphone-ended',
]);
const asWireRecord = (data) => (Object(data) === data ? data : null);
const isNonEmptyString = (value) => (String(value) === value && value.length > 0);
const readResultMessage = (wire) => {
    if (!isNonEmptyString(wire.id))
        return null;
    if (wire.ok === true) {
        const message = {
            channel: OPENCHAMBER_SDK_CHANNEL,
            v: OPENCHAMBER_SDK_API_VERSION,
            type: 'result',
            id: wire.id,
            ok: true,
        };
        if (Object(wire.payload) === wire.payload) {
            // SAFETY: a trusted host answered an id this client issued; the per-call
            // guards in host.ts (isStartSessionResult and friends) narrow the payload
            // before it reaches a caller.
            message.payload = wire.payload;
        }
        return message;
    }
    if (wire.ok === false && isNonEmptyString(wire.error)) {
        return {
            channel: OPENCHAMBER_SDK_CHANNEL,
            v: OPENCHAMBER_SDK_API_VERSION,
            type: 'result',
            id: wire.id,
            ok: false,
            error: wire.error,
            code: resolveHostRequestErrorCode(isNonEmptyString(wire.code) ? wire.code : undefined),
        };
    }
    return null;
};
export const readHostMessage = (data) => {
    const wire = asWireRecord(data);
    if (!wire || wire.channel !== OPENCHAMBER_SDK_CHANNEL || wire.v !== OPENCHAMBER_SDK_API_VERSION)
        return null;
    if (wire.type === 'result')
        return readResultMessage(wire);
    if (!HOST_PUSH_TYPES.has(String(wire.type)) || Object(wire.payload) !== wire.payload)
        return null;
    // SAFETY: envelope and discriminant verified above and the sender is the
    // trusted parent frame; protocol.ts asserts these push shapes against the
    // host's own schema at compile time.
    return wire;
};
