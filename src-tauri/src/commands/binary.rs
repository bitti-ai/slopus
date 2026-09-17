pub(crate) fn percent_decode(value: &str) -> Result<String, String> {
    let source = value.as_bytes();
    let mut bytes = Vec::with_capacity(source.len());
    let mut index = 0;
    while index < source.len() {
        if source[index] == b'%' {
            let digits = source
                .get(index + 1..index + 3)
                .ok_or_else(|| "The export path was cut short after a % escape.".to_string())?;
            let text = std::str::from_utf8(digits)
                .map_err(|_| "The export path has a malformed % escape.".to_string())?;
            let byte = u8::from_str_radix(text, 16)
                .map_err(|_| format!("The export path has a malformed % escape: %{text}"))?;
            bytes.push(byte);
            index += 3;
        } else {
            bytes.push(source[index]);
            index += 1;
        }
    }
    String::from_utf8(bytes).map_err(|_| "The export path is not valid UTF-8.".to_string())
}

/// Decode the common raw-binary IPC metadata envelope once.
pub(crate) fn decoded_header(
    request: &tauri::ipc::Request<'_>,
    name: &str,
) -> Result<String, String> {
    let value = request
        .headers()
        .get(name)
        .ok_or_else(|| format!("Missing {name} header."))?;
    percent_decode(
        value
            .to_str()
            .map_err(|_| format!("Invalid {name} header."))?,
    )
}
