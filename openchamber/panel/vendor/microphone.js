// external: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia#security An opaque-origin iframe cannot call getUserMedia, so the host captures audio.
export const GUEST_MICROPHONE_SAMPLE_RATE_MIN = 8_000;
export const GUEST_MICROPHONE_SAMPLE_RATE_MAX = 192_000;
export const GUEST_MICROPHONE_OPEN_TIMEOUT_MS = 120_000;
export const GUEST_MICROPHONE_FRAME_MAX = 16_384;
export const GUEST_MICROPHONE_END_REASONS = ['revoked', 'device-lost'];
export const createSampleQueue = (capacity) => {
    const chunks = [];
    let offset = 0;
    let queued = 0;
    return {
        push: (samples) => {
            chunks.push(samples);
            queued += samples.length;
            while (queued - offset > capacity && chunks.length > 1) {
                const dropped = chunks.shift();
                queued -= dropped?.length ?? 0;
                offset = 0;
            }
        },
        pull: (out) => {
            let written = 0;
            while (written < out.length && chunks.length > 0) {
                const head = chunks[0];
                const count = Math.min(out.length - written, head.length - offset);
                out.set(head.subarray(offset, offset + count), written);
                written += count;
                offset += count;
                if (offset >= head.length) {
                    chunks.shift();
                    queued -= head.length;
                    offset = 0;
                }
            }
            out.fill(0, written);
        },
        clear: () => {
            chunks.length = 0;
            offset = 0;
            queued = 0;
        },
        get size() {
            return queued - offset;
        },
    };
};
