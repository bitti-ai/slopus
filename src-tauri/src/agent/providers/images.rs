use crate::agent::{capture::CapturedFrame, process::CommandSpec, types::ProviderId};
use serde_json::{json, Value};

pub(super) fn compatible_image_content(text: String, images: &[CapturedFrame]) -> Value {
    if images.is_empty() {
        return Value::String(text);
    }
    let mut content = vec![json!({"type":"text","text":text})];
    for (index, image) in images.iter().enumerate() {
        content.push(json!({"type":"text","text":image.label(index)}));
        content.push(json!({"type":"image_url","image_url":{"url":format!("data:image/png;base64,{}", image.png_base64)}}));
    }
    json!(content)
}

pub(in crate::agent) fn attach_cli_images(
    provider: ProviderId,
    spec: &mut CommandSpec,
    images: &[CapturedFrame],
) -> Result<Option<tempfile::TempDir>, String> {
    if images.is_empty() {
        return Ok(None);
    }
    match provider {
        ProviderId::Codex => {
            let dir = tempfile::Builder::new()
                .prefix("slopus-agent-frames-")
                .tempdir()
                .map_err(|e| e.to_string())?;
            // Insert before the explicit stdin marker. --image is variadic;
            // -- terminates the last image argument before the '-' prompt.
            let marker = spec.args.pop().ok_or("Codex prompt marker is missing.")?;
            for (index, image) in images.iter().enumerate() {
                let path = dir.path().join(format!("timeline-{}.png", index + 1));
                std::fs::write(&path, image.png_bytes()?).map_err(|e| e.to_string())?;
                spec.args.extend(["--image".into(), path.into_os_string()]);
                spec.stdin_payload
                    .get_or_insert_with(String::new)
                    .push_str(&format!("\n{}", image.label(index)));
            }
            spec.args.extend(["--".into(), marker]);
            Ok(Some(dir))
        }
        ProviderId::Claude => {
            spec.args
                .extend(["--input-format".into(), "stream-json".into()]);
            let mut content =
                vec![json!({"type":"text","text":spec.stdin_payload.take().unwrap_or_default()})];
            for (index, image) in images.iter().enumerate() {
                content.push(json!({"type":"text","text":image.label(index)}));
                content.push(json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":image.png_base64}}));
            }
            spec.stdin_payload = Some(format!(
                "{}\n",
                json!({"type":"user", "message":{"role":"user","content":content}, "parent_tool_use_id":null})
            ));
            Ok(None)
        }
        _ => Err("This provider does not use CLI image attachments.".into()),
    }
}
