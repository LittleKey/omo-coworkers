export const GUEST_STATUS_CONTROLS_MAX = 4;
export const GUEST_STATUS_CONTROL_ID = /^[a-z][a-z0-9-]{0,39}$/;
export const GUEST_STATUS_CONTROL_LABEL_MAX = 60;
export const GUEST_STATUS_CONTROL_OPTIONS_MAX = 16;
export const GUEST_STATUS_CONTROL_VALUE_MAX = 80;
const isControlObject = (value) => (Object(value) === value && !Array.isArray(value));
const hasOnlyKeys = (value, keys) => Object.keys(value).every((key) => keys.includes(key));
const isLabel = (value) => (String(value) === value && value.length >= 1 && value.length <= GUEST_STATUS_CONTROL_LABEL_MAX);
const isValue = (value) => (String(value) === value && value.length >= 1 && value.length <= GUEST_STATUS_CONTROL_VALUE_MAX);
export const isGuestStatusControls = (controls) => {
    if (!Array.isArray(controls) || controls.length > GUEST_STATUS_CONTROLS_MAX)
        return false;
    const ids = new Set();
    for (const control of controls) {
        if (!isControlObject(control) || !GUEST_STATUS_CONTROL_ID.test(control.id) || !isLabel(control.label))
            return false;
        if (control.disabled !== undefined && control.disabled !== true && control.disabled !== false)
            return false;
        if (ids.has(control.id))
            return false;
        ids.add(control.id);
        if (control.kind === 'button') {
            if (!hasOnlyKeys(control, ['kind', 'id', 'label', 'disabled']))
                return false;
            continue;
        }
        if (control.kind !== 'select' || !hasOnlyKeys(control, ['kind', 'id', 'label', 'value', 'options', 'disabled']))
            return false;
        if (!isValue(control.value) || !Array.isArray(control.options)
            || control.options.length < 1 || control.options.length > GUEST_STATUS_CONTROL_OPTIONS_MAX)
            return false;
        const values = new Set();
        for (const option of control.options) {
            if (!isControlObject(option) || !hasOnlyKeys(option, ['value', 'label'])
                || !isValue(option.value) || !isLabel(option.label) || values.has(option.value))
                return false;
            values.add(option.value);
        }
        if (!values.has(control.value))
            return false;
    }
    return true;
};
