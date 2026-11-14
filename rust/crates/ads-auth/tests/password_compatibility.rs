use ads_auth::verify_password_scrypt;

#[derive(serde::Deserialize)]
struct PasswordVector {
    password: String,
    encoded: String,
}

#[test]
fn verifies_node_generated_scrypt_vector() {
    let vector: PasswordVector =
        serde_json::from_str(include_str!("../../../contracts/auth/password-vector.json"))
            .expect("password vector is valid JSON");

    assert!(verify_password_scrypt(&vector.password, &vector.encoded));
    assert!(!verify_password_scrypt("not-the-password", &vector.encoded));
}
