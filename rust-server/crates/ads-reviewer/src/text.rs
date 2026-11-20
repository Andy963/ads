pub(crate) fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

pub(crate) fn truncate_utf16(value: &str, max_units: usize) -> &str {
    if utf16_len(value) <= max_units {
        return value;
    }
    let mut units = 0;
    for (index, character) in value.char_indices() {
        let width = character.len_utf16();
        if units + width > max_units {
            return &value[..index];
        }
        units += width;
    }
    value
}
