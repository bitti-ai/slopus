/// Stable identity for correction budgets. Display text is deliberately separate:
/// wording and offending values can change without making a repeated issue new.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct IssueKey {
    pub code: &'static str,
    pub entity: Option<String>,
    pub field: &'static str,
}

#[derive(Debug, Clone)]
pub(crate) struct ValidationIssue {
    pub key: IssueKey,
    pub message: String,
}

impl ValidationIssue {
    pub(crate) fn new(
        code: &'static str,
        entity: Option<String>,
        field: &'static str,
        message: String,
    ) -> Self {
        Self {
            key: IssueKey {
                code,
                entity,
                field,
            },
            message,
        }
    }
}
impl std::fmt::Display for ValidationIssue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
