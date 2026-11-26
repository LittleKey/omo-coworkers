export const GUEST_FILE_EDITORS_MAX = 8;
export const GUEST_FILE_EDITOR_TITLE_MAX = 60;
export const GUEST_FILE_EDITOR_PATTERNS_MAX = 16;
export const GUEST_FILE_EDITOR_PATTERN_MAX = 128;
export const GUEST_FILE_EDITOR_CONTENT_MAX = 20_000_000;
export const GUEST_FILE_EDITOR_VERSION_MAX = 256;
export const isFileEditorPattern = (value) => (value.length > 0
    && value.length <= GUEST_FILE_EDITOR_PATTERN_MAX
    && !/[/\\\0]/.test(value)
    && /[^*?]/.test(value));
const patternExpressions = new Map();
const patternExpression = (pattern) => {
    const cached = patternExpressions.get(pattern);
    if (cached)
        return cached;
    const source = pattern
        .split('')
        .map((character) => {
        if (character === '*')
            return '.*';
        if (character === '?')
            return '.';
        return character.replace(/[\\^$.|+()[\]{}]/g, '\\$&');
    })
        .join('');
    const expression = new RegExp(`^${source}$`, 'is');
    patternExpressions.set(pattern, expression);
    return expression;
};
export const matchesFileEditorPattern = (fileName, pattern) => (isFileEditorPattern(pattern) && patternExpression(pattern).test(fileName));
export const fileEditorPayloadSize = (value) => ('bytes' in value ? value.bytes.byteLength : value.content.length);
export const sameFileEditorDocument = (left, right) => {
    if (left.path !== right.path || left.readOnly !== right.readOnly)
        return false;
    if (left.encoding === 'text' || right.encoding === 'text') {
        return left.encoding === 'text' && right.encoding === 'text' && left.content === right.content;
    }
    if (left.bytes.byteLength !== right.bytes.byteLength)
        return false;
    for (let index = 0; index < left.bytes.byteLength; index += 1) {
        if (left.bytes[index] !== right.bytes[index])
            return false;
    }
    return true;
};
export const createFileSaveTracker = (initialVersion) => {
    let saved = initialVersion;
    let live = initialVersion;
    return {
        observe: (version) => {
            const edited = version !== live;
            live = version;
            return { edited, dirty: version !== saved };
        },
        markSaved: (version) => {
            saved = version;
            return live !== version;
        },
    };
};
