use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// The wire contract distinguishes a missing field, explicit null, and a value.
#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) enum Patch<T> {
    #[default]
    Unchanged,
    Clear,
    Set(T),
}

impl<T> Patch<T> {
    pub(super) fn is_unchanged(&self) -> bool { matches!(self, Self::Unchanged) }
    pub(super) fn is_changed(&self) -> bool { !self.is_unchanged() }
}

impl<T: Clone> Patch<T> {
    pub(super) fn value(&self) -> Option<Option<T>> {
        match self {
            Self::Unchanged => None,
            Self::Clear => Some(None),
            Self::Set(value) => Some(Some(value.clone())),
        }
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Patch<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(match Option::<T>::deserialize(deserializer)? {
            Some(value) => Self::Set(value), None => Self::Clear,
        })
    }
}

impl<T: Serialize> Serialize for Patch<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self { Self::Set(value) => value.serialize(serializer), _ => serializer.serialize_none() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default, Serialize, Deserialize)]
    struct Update {
        #[serde(default, skip_serializing_if = "Patch::is_unchanged")]
        name: Patch<String>,
    }
    #[test]
    fn missing_null_and_value_round_trip_distinctly() {
        for json in ["{}", r#"{"name":null}"#, r#"{"name":"value"}"#] {
            let update: Update = serde_json::from_str(json).unwrap();
            assert_eq!(serde_json::to_string(&update).unwrap(), json);
        }
    }
}
