//! Media format classification and explicit per-use policies.
pub(crate) struct Format {
    pub extension: &'static str,
    pub kind: &'static str,
    pub mime: &'static str,
    pub reference: bool,
}
pub(crate) const FORMATS: &[Format] = &[
    Format {
        extension: "mp4",
        kind: "video",
        mime: "video/mp4",
        reference: true,
    },
    Format {
        extension: "m4v",
        kind: "video",
        mime: "video/mp4",
        reference: true,
    },
    Format {
        extension: "mov",
        kind: "video",
        mime: "video/quicktime",
        reference: true,
    },
    Format {
        extension: "webm",
        kind: "video",
        mime: "video/webm",
        reference: false,
    },
    Format {
        extension: "mkv",
        kind: "video",
        mime: "video/x-matroska",
        reference: false,
    },
    Format {
        extension: "mp3",
        kind: "audio",
        mime: "audio/mpeg",
        reference: false,
    },
    Format {
        extension: "m4a",
        kind: "audio",
        mime: "audio/mp4",
        reference: false,
    },
    Format {
        extension: "aac",
        kind: "audio",
        mime: "audio/mp4",
        reference: false,
    },
    Format {
        extension: "wav",
        kind: "audio",
        mime: "audio/wav",
        reference: false,
    },
    Format {
        extension: "flac",
        kind: "audio",
        mime: "audio/flac",
        reference: false,
    },
    Format {
        extension: "ogg",
        kind: "audio",
        mime: "audio/ogg",
        reference: false,
    },
    Format {
        extension: "oga",
        kind: "audio",
        mime: "audio/ogg",
        reference: false,
    },
    Format {
        extension: "png",
        kind: "image",
        mime: "image/png",
        reference: true,
    },
    Format {
        extension: "jpg",
        kind: "image",
        mime: "image/jpeg",
        reference: true,
    },
    Format {
        extension: "jpeg",
        kind: "image",
        mime: "image/jpeg",
        reference: true,
    },
    Format {
        extension: "webp",
        kind: "image",
        mime: "image/webp",
        reference: true,
    },
    Format {
        extension: "gif",
        kind: "image",
        mime: "image/gif",
        reference: false,
    },
    Format {
        extension: "safetensors",
        kind: "refmod",
        mime: "application/octet-stream",
        reference: true,
    },
];
pub(crate) fn lookup(extension: &str) -> Option<&'static Format> {
    FORMATS.iter().find(|format| format.extension == extension)
}
pub(crate) fn media_kind_and_mime(extension: &str) -> Option<(&'static str, &'static str)> {
    lookup(extension)
        .filter(|format| format.kind != "refmod")
        .map(|format| (format.kind, format.mime))
}
pub(crate) fn media_extensions() -> Vec<&'static str> {
    FORMATS
        .iter()
        .filter(|f| f.kind != "refmod")
        .map(|f| f.extension)
        .collect()
}
pub(crate) fn reference_extensions() -> Vec<&'static str> {
    FORMATS
        .iter()
        .filter(|f| f.reference)
        .map(|f| f.extension)
        .collect()
}
pub(crate) fn image_extensions() -> Vec<&'static str> {
    FORMATS
        .iter()
        .filter(|f| f.reference && f.kind == "image")
        .map(|f| f.extension)
        .collect()
}
pub(crate) fn video_extensions() -> Vec<&'static str> {
    FORMATS
        .iter()
        .filter(|f| f.reference && f.kind == "video")
        .map(|f| f.extension)
        .collect()
}
