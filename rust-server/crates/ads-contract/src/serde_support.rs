use serde::Deserialize;

/// Distinguishes an absent field from an explicit JSON `null` when the field
/// itself is optional but nullable.
pub fn deserialize_present_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}
