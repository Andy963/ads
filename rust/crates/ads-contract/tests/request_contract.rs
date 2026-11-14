use ads_contract::projects::SetActiveProjectRequest;
use serde_json::json;

#[test]
fn set_active_distinguishes_missing_null_and_string_project_ids() {
    let missing = serde_json::from_value::<SetActiveProjectRequest>(json!({}))
        .expect("missing field falls back to default");
    assert_eq!(
        missing.project_id, None,
        "handler rejects missing projectId"
    );

    let null = serde_json::from_value::<SetActiveProjectRequest>(json!({"projectId": null}))
        .expect("null is accepted");
    assert_eq!(null.project_id, Some(None));

    let value = serde_json::from_value::<SetActiveProjectRequest>(json!({"projectId": "p1"}))
        .expect("string is accepted");
    assert_eq!(value.project_id, Some(Some("p1".to_string())));
}
