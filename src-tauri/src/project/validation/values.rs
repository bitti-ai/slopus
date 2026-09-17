use std::collections::{BTreeMap, BTreeSet};
pub(crate) fn is_supported_aspect_ratio(value: &str) -> bool {
    matches!(value, "16:9" | "9:16" | "1:1" | "4:5")
}

/// The same nine names `resolutionSchema` in src/lib/project.ts accepts, and no
/// others in either direction — this layer writes the file the frontend then
/// has to parse. The first six are the ladder a new project is created at, every
/// rung a multiple of 32 on both edges because that is what MiniMax H3
/// generates at; the last three are names already on disk, kept so a project
/// saved before the ladder was rebuilt still opens at the pixels it always had.
/// The pixels themselves live in `outputDimensions` (src/lib/export.ts) — this
/// side validates the name and never needs the geometry.
pub(crate) fn is_supported_resolution(value: &str) -> bool {
    matches!(
        value,
        "416p" | "544p" | "640p" | "768p" | "1088p" | "1344p" | "720p" | "1080p" | "4k"
    )
}

pub(crate) fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        // The same leap rule zod's date regex spells out branch by branch.
        2 if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) => {
            29
        }
        2 => 28,
        // Month 0 and anything past 12 have no days, which rejects the date.
        _ => 0,
    }
}

/// Every date in the schema is validated on the frontend with zod's
/// `z.string().datetime()`. This mirrors zod 3.25's `datetimeRegex` exactly:
/// `YYYY-MM-DD`, a literal `T`, `HH:MM`, OPTIONAL `:SS` which may itself carry
/// an optional `.` plus one or more fractional digits, and a mandatory literal
/// `Z` — no timezone offsets, no lowercase `t`/`z`, and no impossible calendar
/// date (the regex spells out month lengths and the leap-year branch).
///
/// Both directions matter. A value Rust accepts but zod rejects is written to
/// disk and then makes the project unopenable on the next launch; a value zod
/// accepts but Rust rejects makes a legitimate file unsavable. The seconds are
/// genuinely optional in zod, so they are optional here — verified against the
/// installed zod, not assumed.
pub(crate) fn is_iso_datetime(value: &str) -> bool {
    let bytes = value.as_bytes();
    // `YYYY-MM-DDTHH:MMZ` is the shortest accepted form.
    if bytes.len() < 17 {
        return false;
    }
    if bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' || bytes[13] != b':' {
        return false;
    }
    let digits = |range: std::ops::Range<usize>| bytes[range].iter().all(u8::is_ascii_digit);
    if !(digits(0..4) && digits(5..7) && digits(8..10) && digits(11..13) && digits(14..16)) {
        return false;
    }
    let number = |start: usize, end: usize| {
        bytes[start..end]
            .iter()
            .fold(0u32, |total, byte| total * 10 + u32::from(byte - b'0'))
    };
    let (year, month, day) = (number(0, 4), number(5, 7), number(8, 10));
    if day == 0 || day > days_in_month(year, month) {
        return false;
    }
    if number(11, 13) > 23 || number(14, 16) > 59 {
        return false;
    }
    // Seconds are optional. Fractional digits are part of the seconds group, so
    // `...T00:00.5Z` is invalid however tempting it looks.
    let tail = if bytes[16] == b':' {
        if bytes.len() < 20 || !digits(17..19) || number(17, 19) > 59 {
            return false;
        }
        match bytes[19..].split_first() {
            Some((&b'.', fraction)) => {
                let length = fraction
                    .iter()
                    .take_while(|byte| byte.is_ascii_digit())
                    .count();
                if length == 0 {
                    return false;
                }
                &fraction[length..]
            }
            _ => &bytes[19..],
        }
    } else {
        &bytes[16..]
    };
    matches!(tail, b"Z")
}

pub(crate) fn check_iso_datetime(label: &str, value: &str) -> Result<(), String> {
    if is_iso_datetime(value) {
        Ok(())
    } else {
        Err(format!(
            "{label} must be an ISO date-time like 2026-01-01T00:00:00.000Z, received '{value}'."
        ))
    }
}

/// The id shape both validators accept. This IS `SHOT_TAG_ID_PATTERN` from
/// src/lib/shot-tags.ts — `^[a-z][a-zA-Z0-9-]*$` — written out because a regex
/// crate would be a dependency for one pattern. Change one and change the other
/// or the two layers disagree about what may be stored. (The group ids are
/// camelCase, `cameraAmplitude` among them; the leading character is still
/// lowercase so nothing here can be mistaken for a type name or a sentence.)
pub(crate) fn is_shot_tag_id(value: &str) -> bool {
    let mut characters = value.chars();
    matches!(characters.next(), Some(first) if first.is_ascii_lowercase())
        && characters.all(|character| character.is_ascii_alphanumeric() || character == '-')
}

/// Tidies a shot's tags for storage, in the same three steps and the same order
/// as `normalizeShotTagSelection` in src/lib/shot-tags.ts: drop empty groups,
/// drop repeats within a group, and collapse an empty result to `None` so the
/// key is left out of the file entirely. `BTreeMap` also sorts the groups, which
/// is what the frontend's `Object.keys().sort()` does — otherwise the same
/// selection would serialise to different bytes depending on which layer wrote
/// it last, and every save would show a spurious diff.
///
/// Unknown ids are KEPT: the vocabulary is the frontend's, and a build that has
/// never heard of a tag must not silently delete the user's choice.
pub(crate) fn normalize_shot_tags(
    tags: Option<BTreeMap<String, Vec<String>>>,
) -> Result<Option<BTreeMap<String, Vec<String>>>, String> {
    let Some(tags) = tags else {
        return Ok(None);
    };
    let mut normalized: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (group, options) in tags {
        if !is_shot_tag_id(&group) {
            return Err(format!("has an invalid shot tag group '{group}'."));
        }
        let mut kept: Vec<String> = Vec::new();
        for option in options {
            if !is_shot_tag_id(&option) {
                return Err(format!("has an invalid shot tag '{option}'."));
            }
            if !kept.contains(&option) {
                kept.push(option);
            }
        }
        if !kept.is_empty() {
            normalized.insert(group, kept);
        }
    }
    Ok(if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    })
}

pub(crate) fn unique_ids<'a>(
    ids: impl Iterator<Item = &'a str>,
    kind: &str,
) -> Result<BTreeSet<&'a str>, String> {
    let mut unique = BTreeSet::new();
    for id in ids {
        if !unique.insert(id) {
            return Err(format!("Duplicate {kind} id '{id}'."));
        }
    }
    Ok(unique)
}
