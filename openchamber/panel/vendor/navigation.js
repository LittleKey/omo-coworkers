import { OPENCHAMBER_SDK_API_VERSION, OPENCHAMBER_SDK_CHANNEL } from './api-version.js';
export const GUEST_COMMIT_SHA = /^[0-9a-f]{7,64}$/i;
export const isGuestCommitSha = (value) => GUEST_COMMIT_SHA.test(value);
export const GUEST_WALKTHROUGH_BASE_MAX = 255;
export const guestNavigationCalls = (request, nextId, refuse) => ({
    openCommit: (sha) => (isGuestCommitSha(sha)
        ? request({ channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION, type: 'open-commit', id: nextId(), payload: { sha } })
        : refuse('Commit id must be 7 to 64 hex characters.')),
    openWalkthrough: ({ base }) => {
        const trimmed = base.trim();
        if (!trimmed || trimmed.length > GUEST_WALKTHROUGH_BASE_MAX)
            return refuse(`Base must contain 1 to ${GUEST_WALKTHROUGH_BASE_MAX} characters.`);
        return request({ channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION, type: 'open-walkthrough', id: nextId(), payload: { base: trimmed } });
    },
});
