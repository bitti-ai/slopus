pub(super) const MAX_RETRIES_PER_VALIDATION_ISSUE: usize = 3;
pub(super) const MAX_TOTAL_VALIDATION_RETRIES: usize = 12;

#[derive(Default)]
pub(super) struct RetryBudget {
    previous: Option<crate::project::validation::issue::IssueKey>,
    round: usize,
    total: usize,
}
impl RetryBudget {
    pub(super) fn correction(
        &mut self,
        issue: &crate::project::validation::issue::ValidationIssue,
    ) -> Result<usize, String> {
        if self.previous.as_ref() == Some(&issue.key) {
            self.round += 1;
        } else {
            self.previous = Some(issue.key.clone());
            self.round = 1;
        }
        if self.round > MAX_RETRIES_PER_VALIDATION_ISSUE {
            return Err(format!("Slop stopped after {MAX_RETRIES_PER_VALIDATION_ISSUE} correction rounds because the validator kept reporting the same failure: {issue}"));
        }
        if self.total >= MAX_TOTAL_VALIDATION_RETRIES {
            return Err(format!("Slop stopped after {MAX_TOTAL_VALIDATION_RETRIES} total correction rounds without reaching a valid project. Last validator failure: {issue}"));
        }
        self.total += 1;
        Ok(self.round)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::validation::issue::ValidationIssue;
    #[test]
    fn changed_wording_does_not_reset_the_same_issue_budget() {
        let mut budget = RetryBudget::default();
        for round in 1..=3 {
            let issue = ValidationIssue::new(
                "scene.invalid",
                Some("scene-1".into()),
                "duration",
                format!("Bad value {round}"),
            );
            assert_eq!(budget.correction(&issue).unwrap(), round);
        }
        assert!(budget
            .correction(&ValidationIssue::new(
                "scene.invalid",
                Some("scene-1".into()),
                "duration",
                "Different wording".into()
            ))
            .is_err());
        assert_eq!(
            budget
                .correction(&ValidationIssue::new(
                    "scene.invalid",
                    Some("scene-1".into()),
                    "references",
                    "Missing reference".into()
                ))
                .unwrap(),
            1
        );
    }
}
pub(super) fn validation_retry_prompt(
    original: &str,
    previous: &str,
    failure: &str,
    round: usize,
) -> String {
    format!(
        "Your previous response was rejected by Slopus's project validator. Correction round {round} of {MAX_RETRIES_PER_VALIDATION_ISSUE} for this issue.\n\nValidator failure:\n<validator-error>\n{failure}\n</validator-error>\n\nOriginal user request:\n<original-request>\n{original}\n</original-request>\n\nRejected response:\n<rejected-response>\n{previous}\n</rejected-response>\n\nFix the validator failure while preserving the user's intent. Return the complete answer/question object or complete JSONL command stream again, using exactly the required turn contract."
    )
}
