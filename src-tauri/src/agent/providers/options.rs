use crate::project::{ProviderSetting, ProviderOption};
pub(in crate::agent) fn option_string<'a>(setting: &'a ProviderSetting, key: &str) -> Option<&'a str> {
    match setting.options.get(key) {
        Some(ProviderOption::String(value)) => Some(value),
        _ => None,
    }
}
pub(in crate::agent) fn option_number(setting: &ProviderSetting, key: &str) -> Option<f64> {
    match setting.options.get(key) {
        Some(ProviderOption::Number(value)) => Some(*value),
        _ => None,
    }
}
