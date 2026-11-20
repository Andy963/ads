use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngCore;
use rand::rngs::OsRng;
use scrypt::{Params, scrypt};
use subtle::ConstantTimeEq;

const SCRYPT_LOG_N: u8 = 14;
const SCRYPT_R: u32 = 8;
const SCRYPT_P: u32 = 1;
const SCRYPT_OUTPUT_LEN: usize = 32;
const SCRYPT_SALT_LEN: usize = 16;

struct ParsedScrypt {
    log_n: u8,
    r: u32,
    p: u32,
    salt: Vec<u8>,
    hash: Vec<u8>,
}

pub fn hash_password_scrypt(password: &str) -> String {
    let mut salt = [0_u8; SCRYPT_SALT_LEN];
    OsRng.fill_bytes(&mut salt);
    let mut derived = [0_u8; SCRYPT_OUTPUT_LEN];
    let params =
        Params::new(SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P).expect("static scrypt parameters are valid");
    scrypt(password.as_bytes(), &salt, &params, &mut derived)
        .expect("static scrypt parameters produce a valid key");

    format!(
        "scrypt$N={}$r={}$p={}$salt={}$hash={}",
        1_u64 << SCRYPT_LOG_N,
        SCRYPT_R,
        SCRYPT_P,
        URL_SAFE_NO_PAD.encode(salt),
        URL_SAFE_NO_PAD.encode(derived)
    )
}

pub fn verify_password_scrypt(password: &str, stored: &str) -> bool {
    let Some(parsed) = parse_scrypt_hash(stored) else {
        return false;
    };
    let Ok(params) = Params::new(parsed.log_n, parsed.r, parsed.p) else {
        return false;
    };
    let mut derived = vec![0_u8; parsed.hash.len()];
    if scrypt(password.as_bytes(), &parsed.salt, &params, &mut derived).is_err() {
        return false;
    }
    derived.ct_eq(&parsed.hash).into()
}

fn parse_scrypt_hash(stored: &str) -> Option<ParsedScrypt> {
    let raw = stored.trim();
    if !raw.starts_with("scrypt$") {
        return None;
    }

    let mut n = None;
    let mut r = None;
    let mut p = None;
    let mut salt = None;
    let mut hash = None;
    for part in raw.split('$').skip(1) {
        let Some((key, value)) = part.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        if key.is_empty() || value.is_empty() {
            continue;
        }
        match key {
            "N" => n = value.parse::<u64>().ok(),
            "r" => r = value.parse::<u32>().ok(),
            "p" => p = value.parse::<u32>().ok(),
            "salt" => salt = URL_SAFE_NO_PAD.decode(value).ok(),
            "hash" => hash = URL_SAFE_NO_PAD.decode(value).ok(),
            _ => {}
        }
    }

    let n = n?;
    if n == 0 || !n.is_power_of_two() {
        return None;
    }
    let log_n = n.trailing_zeros();
    if log_n > u8::MAX as u32 {
        return None;
    }

    Some(ParsedScrypt {
        log_n: log_n as u8,
        r: r?,
        p: p?,
        salt: salt?,
        hash: hash?,
    })
}

#[cfg(test)]
mod tests {
    use super::{hash_password_scrypt, verify_password_scrypt};

    #[test]
    fn round_trips_password_hash() {
        let encoded = hash_password_scrypt("correct horse battery staple");
        assert!(encoded.starts_with("scrypt$N=16384$r=8$p=1$"));
        assert!(verify_password_scrypt(
            "correct horse battery staple",
            &encoded
        ));
        assert!(!verify_password_scrypt("wrong", &encoded));
        assert!(!verify_password_scrypt("wrong", "not-a-hash"));
    }

    #[test]
    fn scrypt_encoding_uses_node_compatible_n_value() {
        let encoded = hash_password_scrypt("password");
        assert!(encoded.starts_with("scrypt$N=16384$r=8$p=1$salt="));
    }
}
